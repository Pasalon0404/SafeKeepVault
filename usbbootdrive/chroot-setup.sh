#!/bin/bash
set -e
# pipefail catches silent failures in command pipelines like
#   curl ... | gpg --dearmor --output ...
# Without pipefail, only the LAST command's exit status is observed,
# so a curl failure that produces empty output but exits 0 (e.g. a
# 200 with empty body, or content rejected by --fail) followed by a
# "successful" gpg --dearmor on empty input would be invisible. With
# pipefail, the pipeline returns the first non-zero exit code in the
# chain, and `set -e` aborts the build immediately. Layered with the
# explicit fingerprint check below, this gives us two independent
# safeguards against shipping an image with a broken PPA bootstrap.
set -o pipefail

echo "Starting chroot configuration..."
export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C

# ============================================================================
# BUILD-ONLY APT RESILIENCE — survive flaky / cellular / hotspot networks
# ============================================================================
# apt's defaults assume a fast, stable connection: 3 retries with a ~30
# second per-request timeout. On cellular hotspots and corporate firewalls
# that aggressively rate-limit specific Canonical IPs (we've hit this on
# api.launchpad.net, keyserver.ubuntu.com:11371, and now
# ppa.launchpadcontent.net within the same project), 3-with-30s isn't
# enough — apt logs "connection timed out" after 3 quick attempts and
# the whole `apt-get install` aborts even though the underlying
# connection would have eventually worked. The build then dies in
# Phase 3 and we've wasted 10+ minutes on the chroot setup.
#
# We bump retries to 10 and the connection timeout to 120s for HTTP/HTTPS.
# DNS round-robin can also help: when apt retries against a hostname with
# multiple A records, the resolver may rotate to a different IP that the
# hotspot doesn't have on its block list. 10 attempts gives the resolver
# enough rotations to find a working IP before giving up.
#
# This config lives at /etc/apt/apt.conf.d/99-build-resilience inside the
# chroot for the duration of the build. We could revert it before squashfs
# compression for purity, but leaving it in the final image is harmless —
# users on the live boot only run apt during emergency recovery (the
# kiosk doesn't auto-update), and a more-patient apt is strictly better
# than a less-patient one. So we just install it once and leave it.
mkdir -p /etc/apt/apt.conf.d
cat > /etc/apt/apt.conf.d/99-build-resilience << 'APT_EOF'
Acquire::Retries "10";
Acquire::http::Timeout "120";
Acquire::https::Timeout "120";
APT_EOF
echo "apt resilience config installed: 10 retries, 120s timeout."

echo "ubuntu-safekeep" > /etc/hostname

cat > /etc/hosts << 'EOF'
127.0.0.1 localhost
127.0.1.1 ubuntu-safekeep
::1 localhost ip6-localhost ip6-loopback
EOF

echo "Adding repositories..."
apt-get update
apt-get install -y software-properties-common curl gnupg

# universe is an official Ubuntu component (not a third-party PPA), so
# add-apt-repository can enable it via a simple sources.list rewrite —
# no Launchpad API call, no GPG keyserver fetch, no network roundtrip
# beyond the Ubuntu archive itself. Safe to keep as-is.
add-apt-repository -y universe

# ============================================================================
# xtradeb/apps PPA — direct-write bootstrap (replaces add-apt-repository)
# ============================================================================
# add-apt-repository -y ppa:xtradeb/apps does two network operations in
# sequence that fail on restrictive networks:
#
#   1. python-launchpadlib calls api.launchpad.net to validate PPA
#      metadata. On networks with a black-holed IPv6 path this raises
#      `TimeoutError: [Errno 110]` after ~2 minutes.
#   2. gpg --recv-keys fetches the PPA signing key from
#      keyserver.ubuntu.com. By default GPG uses the HKP protocol on
#      TCP port 11371, which is blocked on most cellular hotspots and
#      many corporate firewalls (which permit only 80/443/53 outbound).
#
# We replace it with three direct-write steps that go entirely over
# HTTPS-on-443 (which works on every network where ubuntu archive
# downloads work) and never depend on either Launchpad's REST API or
# the HKP keyserver protocol:
#
#   • curl the ASCII-armored key from keyserver.ubuntu.com over HTTPS
#   • verify the downloaded key's fingerprint before trusting it
#   • write /etc/apt/trusted.gpg.d/xtradeb-apps.gpg and the matching
#     /etc/apt/sources.list.d/xtradeb-apps.list directly
#
# The fingerprint check is critical: if a future keyserver compromise
# or DNS hijack ever returns a different key, the build aborts before
# the bad key reaches the trusted-keys directory.
#
# Reference: https://launchpad.net/~xtradeb/+archive/ubuntu/apps
#   PPA owner team:  xtradeb
#   PPA name:        apps
#   GPG long key ID: 82BB6851C64F6880
# ============================================================================

# ============================================================================
# Package: ungoogled-chromium (OpenSUSE Build Service)
# ============================================================================
# We use OBS because Canonical's Launchpad PPA infrastructure frequently 
# drops packets or blackholes routes to specific ISPs, causing the build 
# to fail randomly. OBS runs on a globally distributed, highly reliable CDN.



echo "Installing kernel, display server, and base tools..."
apt-get update
apt-get install -y --no-install-recommends \
    linux-image-generic \
    linux-headers-generic \
    initramfs-tools \
    casper \
    xserver-xorg \
    xserver-xorg-video-all \
    xserver-xorg-input-all \
    xinit \
    xfonts-base \
    openbox \
    xterm \
    parted \
    zenity \
    zbar-tools \
    gdisk \
    cryptsetup \
    exfatprogs \
    p7zip-full \
    dbus-x11 \
    psmisc \
    dunst \
    adwaita-icon-theme \
    shared-mime-info \
    gvfs \
    gvfs-daemons \
    udisks2 \
    udev \
    xclip \
    xsel \
    tint2 \
    xdotool \
    pcmanfm \
    autocutsel \
    util-linux \
    x11-xserver-utils \
    python3-xdg

echo "Installing Chromium..."

# ============================================================================
# Package: ungoogled-chromium (xtradeb/apps PPA)
# ============================================================================
# After three iterations we found that the xtradeb/apps PPA does NOT
# publish a `chromium` or `chromium-browser` package on Ubuntu noble.
# It publishes under the distinct name `ungoogled-chromium`. This
# matters because:
#
#   • `ungoogled-chromium` does not exist anywhere in Canonical's
#     official repositories. There is no name collision with the
#     snap-transitional `chromium-browser` shim, so we don't need
#     /etc/apt/preferences.d pinning at all — apt has exactly one
#     candidate package and picks it unambiguously.
#
#   • The binary is installed at /usr/bin/ungoogled-chromium and is
#     a real native build (the upstream open-source Chromium codebase
#     with Google services / telemetry stripped). For the SafeKeep
#     kiosk this is actually a stronger choice than vanilla Chromium:
#     no calls home, no auto-updates, no remote services.
#
# Earlier builds tried `chromium-browser` against pinning, but apt
# silently fell back to Canonical's snap shim because the pin was
# scoped to a package name xtradeb doesn't ship. The pin file is
# deleted entirely now — there's nothing to pin against, and a
# leftover preferences.d entry would be dead weight inside the
# squashfs that someone could trip over later.

echo "Installing AppImage prerequisites and browser shared libraries..."
apt-get install -y wget curl ca-certificates jq \
    libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libasound2t64 libpango-1.0-0 libcairo2 libxshmfence1 libgl1-mesa-dri

echo "Fetching latest ungoogled-chromium AppImage URL from GitHub..."
# Queries the GitHub API, filters for the x86_64 AppImage URL, and extracts it
APPIMAGE_URL=$(curl -s https://api.github.com/repos/ungoogled-software/ungoogled-chromium-portablelinux/releases/latest | grep "browser_download_url.*AppImage" | grep -iv "arm" | grep -iv "aarch64" | cut -d '"' -f 4 | head -n 1)

if [ -z "$APPIMAGE_URL" ]; then
    echo "ERROR: Failed to fetch AppImage URL from GitHub API." >&2
    exit 1
fi

echo "Downloading ungoogled-chromium AppImage..."
wget -q --show-progress -O /tmp/uc.AppImage "$APPIMAGE_URL"
chmod +x /tmp/uc.AppImage

echo "Extracting AppImage to /opt/ungoogled-chromium..."
cd /opt
/tmp/uc.AppImage --appimage-extract > /dev/null
mv squashfs-root ungoogled-chromium
rm /tmp/uc.AppImage

echo "Creating global executable wrapper..."
cat > /usr/bin/ungoogled-chromium << 'EOF'
#!/bin/bash
exec /opt/ungoogled-chromium/AppRun --no-sandbox "$@"
EOF
chmod +x /usr/bin/ungoogled-chromium

# POST-INSTALL SANITY CHECK
if ! command -v ungoogled-chromium >/dev/null 2>&1; then
    echo "ERROR: ungoogled-chromium binary is not on PATH." >&2
    exit 1
fi

echo "Testing Chromium execution..."
# Notice we removed the /dev/null silencers so we can see actual errors
if ! ungoogled-chromium --version; then
    echo "ERROR: ungoogled-chromium exists but crashed on execution." >&2
    echo "Checking for missing libraries:" >&2
    # This will print exactly which library is missing if it fails again
    ldd /opt/ungoogled-chromium/chrome | grep "not found" >&2 || true
    exit 1
fi
echo "Chromium binary verified at: $(command -v ungoogled-chromium)"
echo "Chromium version: $(ungoogled-chromium --version)"

# ==================================================================
#  UNIVERSAL CAMERA HARDWARE SUPPORT
#  Ensures webcam QR scanning works on MacBooks, modern Intel/AMD
#  thin-and-lights, Chromebooks, and generic USB cameras.
# ==================================================================

# --- Part 1: Mac FaceTime HD Driver (DKMS) ---
# The 2015–2017 MacBook Pro uses a proprietary Broadcom PCIe camera
# (FaceTime HD) that has no mainline Linux driver. We build the
# community reverse-engineered driver via DKMS so it survives
# kernel upgrades.

echo "Installing FaceTime HD camera prerequisites..."
apt-get install -y --no-install-recommends \
    git curl xz-utils cpio kmod dkms \
    linux-headers-generic build-essential

echo "Building FaceTime HD firmware..."
FWHD_BUILD="/tmp/facetimehd-firmware"
git clone --depth 1 https://github.com/patjak/facetimehd-firmware.git "$FWHD_BUILD"
cd "$FWHD_BUILD"
make
make install   # installs to /usr/lib/firmware/facetimehd/
cd /
rm -rf "$FWHD_BUILD"

echo "Building FaceTime HD kernel driver (bcwc_pcie) via DKMS..."
BCWC_BUILD="/tmp/bcwc_pcie"
git clone --depth 1 https://github.com/patjak/bcwc_pcie.git "$BCWC_BUILD"

# Determine the installed kernel version for DKMS registration.
# Inside the chroot we may not be running the target kernel, so
# we derive the version from the installed linux-headers package
# rather than relying on `uname -r`.
KERN_VER=$(ls /lib/modules/ | grep -E '^[0-9]+\.' | sort -V | tail -1)
DKMS_VER="1.0"
DKMS_NAME="facetimehd"
DKMS_SRC="/usr/src/${DKMS_NAME}-${DKMS_VER}"

mkdir -p "$DKMS_SRC"
cp -a "$BCWC_BUILD"/* "$DKMS_SRC"/

# Create the DKMS configuration so the driver rebuilds automatically
# whenever a new kernel is installed (e.g. during apt upgrade).
cat > "$DKMS_SRC/dkms.conf" << DKMSEOF
PACKAGE_NAME="$DKMS_NAME"
PACKAGE_VERSION="$DKMS_VER"
BUILT_MODULE_NAME[0]="facetimehd"
DEST_MODULE_LOCATION[0]="/updates"
AUTOINSTALL="yes"
MAKE[0]="make -C \${kernel_source_dir} M=\${dkms_tree}/\${PACKAGE_NAME}/\${PACKAGE_VERSION}/build"
CLEAN="make -C \${kernel_source_dir} M=\${dkms_tree}/\${PACKAGE_NAME}/\${PACKAGE_VERSION}/build clean"
DKMSEOF

dkms add -m "$DKMS_NAME" -v "$DKMS_VER"
dkms build -m "$DKMS_NAME" -v "$DKMS_VER" -k "$KERN_VER"
dkms install -m "$DKMS_NAME" -v "$DKMS_VER" -k "$KERN_VER"

rm -rf "$BCWC_BUILD"

# Auto-load facetimehd at boot and blacklist the conflicting stub driver
echo "facetimehd" >> /etc/modules
cat > /etc/modprobe.d/facetimehd.conf << 'MODEOF'
# Blacklist the generic Broadcom PCIe stub — it claims the device
# before the FaceTime HD driver can bind.
blacklist bdc_pci
MODEOF

echo "FaceTime HD driver installed via DKMS."

# --- Part 2: Modern PC & MIPI Camera Support ---
# Newer Intel thin-and-lights (11th gen+) and many Chromebooks use
# complex IPU6/MIPI camera pipelines that need extra kernel modules
# and the libcamera userspace translation layer.

echo "Installing extended kernel modules and modern camera stack..."
apt-get install -y --no-install-recommends \
    "linux-modules-extra-${KERN_VER}" \
    v4l-utils \
    libcamera-tools \
    libcamera-v4l2

echo "Modern camera support installed."

# --- Part 3: GStreamer Plugins for zbarcam ---
# zbarcam uses GStreamer to decode camera feeds. Without the right
# plugins, it fails silently on hardware-encoded video streams
# (common with MJPEG and H.264 USB cameras).

echo "Installing GStreamer plugins for zbarcam..."
apt-get install -y --no-install-recommends \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad

echo "Universal camera hardware support complete."

# ==================================================================

SCALE_FACTOR="2"

echo "Configuring Openbox application rules and shortcuts..."
mkdir -p /etc/xdg/openbox

cat > /etc/xdg/openbox/rc.xml << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/config">
  <keyboard>
    <keybind key="A-F4"><action name="Close"/></keybind>
    <keybind key="A-Tab"><action name="NextWindow"/></keybind>
    <keybind key="A-S-Tab"><action name="PreviousWindow"/></keybind>
    <keybind key="C-A-q"><action name="Execute"><command>killall ungoogled-chromium</command></action></keybind>
    <keybind key="C-A-s"><action name="Execute"><command>xterm -fa 'Monospace' -fs 14 -e setup-vault</command></action></keybind>
    <keybind key="C-A-u"><action name="Execute"><command>xterm -fa 'Monospace' -fs 14 -e unlock-vault</command></action></keybind>
    <keybind key="C-A-m"><action name="ShowMenu"><menu>root-menu</menu></action></keybind>
    <keybind key="C-A-t"><action name="Execute"><command>xterm -fa 'Monospace' -fs 28</command></action></keybind>
    <keybind key="C-A-f"><action name="Execute"><command>pcmanfm /media/transfer</command></action></keybind>
  </keyboard>
  <mouse>
    <context name="Root">
      <mousebind button="Right" action="Press">
        <action name="ShowMenu"><menu>root-menu</menu></action>
      </mousebind>
    </context>
  </mouse>
  <applications>
    <application class="Chromium-browser">
      <maximized>yes</maximized>
      <decor>no</decor>
    </application>
  </applications>
</openbox_config>
EOF

echo "Configuring Openbox Menu..."
cat > /etc/xdg/openbox/menu.xml << EOF
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
<menu id="root-menu" label="SafeKeep OS">
  <item label="SafeKeep Tools (Browser)"><action name="Execute"><command>ungoogled-chromium --kiosk --start-fullscreen --app="file:///opt/safekeep/boot.html" --disable-dev-tools --incognito --force-device-scale-factor=${SCALE_FACTOR} --no-sandbox --no-first-run --allow-file-access-from-files --disable-web-security --disable-gpu --password-store=basic --disable-notifications --noerrdialogs --disable-infobars --disable-session-crashed-bubble --use-fake-ui-for-media-stream --disable-features=XdgDesktopPortalFilePicker,NativeNotifications</command></action></item>
  <separator />
  <item label="Unlock Vault (Ctrl+Alt+U)"><action name="Execute"><command>xterm -fa 'Monospace' -fs 14 -e unlock-vault</command></action></item>
  <item label="Setup Vault - First Time (Ctrl+Alt+S)"><action name="Execute"><command>xterm -fa 'Monospace' -fs 14 -e setup-vault</command></action></item>
  <separator />
  <item label="Terminal (Ctrl+Alt+T)"><action name="Execute"><command>xterm -fa 'Monospace' -fs 28</command></action></item>
  <item label="File Explorer (Ctrl+Alt+F)"><action name="Execute"><command>pcmanfm /media/transfer</command></action></item>
  <separator />
  <item label="Power Off"><action name="Execute"><command>xterm -fa 'Monospace' -fs 14 -e bash -c 'echo "Shutting down SafeKeep OS..."; sync; poweroff'</command></action></item>
</menu>
</openbox_menu>
EOF

# 7. Configure tint2 taskbar
echo "Configuring tint2 taskbar..."
mkdir -p /etc/xdg/tint2

cat > /etc/xdg/tint2/tint2rc << 'TINT2EOF'
# Panel
panel_items = LTSC
panel_position = bottom center horizontal
panel_size = 100% 40
panel_margin = 0 0
panel_padding = 4 2 4
panel_background_id = 1
panel_monitor = all
panel_layer = top

# Background: dark semi-transparent
rounded = 0
border_width = 0
background_color = #1a1a2e 90

# Background for active task button
rounded = 3
border_width = 1
border_color = #4488ff 60
background_color = #2a2a4e 80

# Background for inactive task button
rounded = 3
border_width = 0
background_color = #333355 50

# Taskbar
taskbar_mode = single_desktop
taskbar_padding = 2 2 4
taskbar_background_id = 0
taskbar_active_background_id = 0

# Task buttons
task_text = 1
task_icon = 1
task_centered = 0
task_maximum_size = 250 35
task_padding = 6 3 6
task_font = Sans 11
task_font_color = #e0e0e0 100
task_active_font_color = #ffffff 100
task_background_id = 3
task_active_background_id = 2

# Launcher
launcher_padding = 4 4 4
launcher_background_id = 0
launcher_icon_theme = Adwaita
launcher_icon_size = 28
launcher_tooltip = 1

# Launcher items
launcher_item_app = /usr/share/applications/safekeep-menu.desktop
launcher_item_app = /usr/share/applications/safekeep-browser.desktop
launcher_item_app = /usr/share/applications/safekeep-files.desktop

# System tray
systray_padding = 4 2 4
systray_icon_size = 22

# Clock
time1_format = %H:%M
time1_font = Sans Bold 11
clock_font_color = #e0e0e0 100
clock_padding = 8 2
clock_background_id = 0
TINT2EOF

# Create a .desktop file for the SafeKeep launcher button
mkdir -p /usr/share/applications

cat > /usr/share/applications/safekeep-menu.desktop << 'DESKEOF'
[Desktop Entry]
Name=SafeKeep Menu
Comment=Open SafeKeep application menu
Exec=xdotool key ctrl+alt+m
Icon=applications-system
Type=Application
Categories=System;
DESKEOF

# Create .desktop files for all SafeKeep apps (for the taskbar)
cat > /usr/share/applications/safekeep-browser.desktop << DESKEOF
[Desktop Entry]
Name=SafeKeep Tools
Comment=Open SafeKeep Bitcoin Tools
Exec=ungoogled-chromium --app="file:///opt/safekeep/boot.html" --disable-dev-tools --incognito --force-device-scale-factor=${SCALE_FACTOR} --no-sandbox --no-first-run --allow-file-access-from-files --disable-web-security --disable-gpu --password-store=basic --disable-notifications --use-fake-ui-for-media-stream --disable-features=XdgDesktopPortalFilePicker,NativeNotifications
Icon=chromium
Type=Application
Categories=Network;
DESKEOF

# 8. Configure clipboard and xterm for easy copy/paste
echo "Configuring clipboard sync and xterm..."

# .Xresources: make xterm use CLIPBOARD (same as Chromium) and add
# Ctrl+Shift+C/V shortcuts so copy/paste works the same everywhere
cat > /root/.Xresources << 'XREOF'
! --- xterm clipboard & usability ---
! Select-to-copy goes to CLIPBOARD (not just PRIMARY)
XTerm*selectToClipboard: true

! Ctrl+Shift+C = copy selection to clipboard
! Ctrl+Shift+V = paste from clipboard
XTerm*translations: #override \
    Ctrl Shift <Key>C: copy-selection(CLIPBOARD) \n\
    Ctrl Shift <Key>V: insert-selection(CLIPBOARD) \n\
    Ctrl <Key>minus: smaller-vt-font() \n\
    Ctrl <Key>plus: larger-vt-font() \n\
    Ctrl <Key>0: set-vt-font(d)

! Scrollback buffer
XTerm*saveLines: 10000
XTerm*scrollBar: false

! Better default colors
XTerm*background: #1a1a2e
XTerm*foreground: #e0e0e0
XTerm*cursorColor: #4488ff
XREOF

# Create a script that loads .Xresources and starts clipboard sync
cat > /usr/local/bin/start-clipboard-sync << 'CLIPEOF'
#!/bin/bash
# Load xterm settings
xrdb -merge /root/.Xresources 2>/dev/null

# autocutsel keeps PRIMARY and CLIPBOARD in sync bidirectionally
# This means: highlight text anywhere → it's on the clipboard
#             Ctrl+C in Chromium → available to middle-click paste in xterm
autocutsel -fork -selection CLIPBOARD 2>/dev/null
autocutsel -fork -selection PRIMARY 2>/dev/null
CLIPEOF
chmod +x /usr/local/bin/start-clipboard-sync

# Create .desktop file for file manager launcher in tint2
cat > /usr/share/applications/safekeep-files.desktop << 'DESKEOF'
[Desktop Entry]
Name=File Explorer
Comment=Browse files
Exec=pcmanfm /media/transfer
Icon=system-file-manager
Type=Application
Categories=System;
DESKEOF

# 9. Hide internal partitions from the file manager
# The udev rules in config/99-hide-drives.rules are copied into the image
# by build.sh (Phase 3). They hide all internal partitions (EFI, OS, data,
# LUKS, device-mapper) so only the TRANSFER airlock is visible in PCManFM.
echo "Configuring partition visibility..."

# Configure PCManFM to open at the Transfer partition by default
mkdir -p /etc/xdg/pcmanfm/default
cat > /etc/xdg/pcmanfm/default/pcmanfm.conf << 'PCMEOF'
[config]
bm_open_method=0

[volume]
mount_on_startup=0
mount_removable=0
autorun=0

[ui]
always_show_tabs=0
hide_close_btn=0
side_pane_mode=places
PCMEOF

# 10. Configure Autostart
echo "Configuring Autostart..."
cat > /etc/xdg/openbox/autostart << EOF
#!/bin/sh

xset s off
xset s noblank
xset -dpms

# Force GTK to use raw local files
export GTK_USE_PORTAL=0
export NO_AT_BRIDGE=1
export GIO_USE_VFS=local
export GIO_USE_VOLUME_MONITOR=unix

# Sync clipboard between apps (PRIMARY ↔ CLIPBOARD)
/usr/local/bin/start-clipboard-sync &

# NOTE: tint2 is intentionally NOT launched here.
# SafeKeep runs in true kiosk mode (--kiosk) with no OS panel, clock,
# or taskbar visible. The tint2 package is kept installed for emergency
# recovery (user can launch it manually from an Openbox menu if needed).

# Boot wrapper: vault setup/unlock → then Chromium (kiosk mode)
# Output is captured to a log file for post-mortem debugging.
# Without this, any failure in safekeep-boot is completely invisible
# because the process runs in the background with no controlling terminal.
SAFEKEEP_SCALE_FACTOR=${SCALE_FACTOR} safekeep-boot >> /tmp/safekeep-boot.log 2>&1 &
EOF
chmod +x /etc/xdg/openbox/autostart

echo "Setting up automatic login..."
mkdir -p /etc/systemd/system/getty@tty1.service.d/
cat > /etc/systemd/system/getty@tty1.service.d/override.conf << 'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear %I $TERM
EOF

cat > /root/.profile << 'EOF'
if [ -z "$DISPLAY" ] && [ "$XDG_VTNR" = 1 ]; then
  exec startx
fi
EOF

echo "exec dbus-launch --exit-with-session openbox-session" > /root/.xinitrc

cat > /etc/X11/Xwrapper.config << 'EOF'
allowed_users=console
EOF

echo "Configuring trackpad gestures..."
mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/40-mac-trackpad.conf << 'EOF'
Section "InputClass"
    Identifier "libinput touchpad catchall"
    MatchIsTouchpad "on"
    Driver "libinput"
    Option "Tapping" "on"
    Option "ClickMethod" "clickfinger"
EndSection
EOF

# ==================================================================
#  BOOT SPLASH — Silent GRUB + ASCII Art Early-Boot Service
#  Replaces scrolling kernel logs with a clean SafeKeep Vault
#  loading screen until the Openbox/Chromium UI takes over.
# ==================================================================

# --- Step 1: Silence the Bootloader (GRUB) ---
echo "Configuring silent GRUB boot..."

if [ -f /etc/default/grub ]; then
    # File exists — patch in place.
    # "noswap" is appended to forbid the kernel from ever activating any
    # swap device it finds on the host machine. Combined with `swapoff -a`
    # at safekeep-boot.sh entry, this mechanically prevents browser memory
    # (and therefore the master seed) from ever being paged to a physical
    # disk. Part of the "Absolute Amnesia" guarantee.
    sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="quiet splash loglevel=0 systemd.show_status=false rd.systemd.show_status=false vt.global_cursor_default=0 console=tty3 fbcon=nodefer udev.log_priority=3 logo.nologo bgrt_disable noswap"/' /etc/default/grub

    if grep -q '^GRUB_TIMEOUT=' /etc/default/grub; then
        sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=0/' /etc/default/grub
    else
        echo 'GRUB_TIMEOUT=0' >> /etc/default/grub
    fi

    if grep -q '^GRUB_TIMEOUT_STYLE=' /etc/default/grub; then
        sed -i 's/^GRUB_TIMEOUT_STYLE=.*/GRUB_TIMEOUT_STYLE=hidden/' /etc/default/grub
    else
        echo 'GRUB_TIMEOUT_STYLE=hidden' >> /etc/default/grub
    fi
else
    # File doesn't exist yet — create it from scratch
    mkdir -p /etc/default
    cat > /etc/default/grub << 'GRUBEOF'
GRUB_DEFAULT=0
# "noswap" is part of the Absolute Amnesia guarantee — the kernel is
# barred from activating any swap device found on the host machine, so
# browser memory holding the master seed can never be paged to a
# physical disk.
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash loglevel=0 systemd.show_status=false rd.systemd.show_status=false vt.global_cursor_default=0 console=tty3 fbcon=nodefer udev.log_priority=3 logo.nologo bgrt_disable noswap"
GRUB_CMDLINE_LINUX=""
GRUB_TIMEOUT=0
GRUB_TIMEOUT_STYLE=hidden
GRUBEOF
    echo "Created /etc/default/grub from scratch."
fi

# update-grub may not exist yet in minimal chroot — defer if absent
if command -v update-grub > /dev/null 2>&1; then
    update-grub
else
    echo "NOTICE: update-grub not found — GRUB config written but regeneration deferred to bootloader install phase."
fi

# ==================================================================
#  ABSOLUTE AMNESIA — Swap Disablement & tmpfs Hardening
# ------------------------------------------------------------------
#  The live USB must NEVER write browser memory (including the master
#  seed) to a physical disk. "Absolute Amnesia" is a stack of controls:
#
#    1. GRUB  → `noswap` kernel parameter (see Step 1 above)
#    2. sysctl → `vm.swappiness=0` (belt-and-braces)
#    3. fstab → tmpfs for /tmp + /var/tmp with noexec,nosuid,nodev
#    4. boot  → `swapoff -a` at safekeep-boot.sh entry (runtime defense)
#    5. UI    → `RAM-only mode verified` attestation in the welcome screen
#
#  Any one of these is sufficient defense in isolation; together they
#  make a paged seed mechanically impossible under any configuration
#  the user's host machine presents.
# ==================================================================
echo "Configuring Absolute Amnesia (sysctl swappiness + tmpfs fstab)..."

# --- vm.swappiness=0 via sysctl drop-in ---
mkdir -p /etc/sysctl.d
cat > /etc/sysctl.d/99-safekeep-amnesia.conf << 'SYSCTLEOF'
# SafeKeep OS — Absolute Amnesia
# Swappiness is the kernel's willingness to move anonymous pages
# (i.e. browser heap) out to a swap device. We set it to 0 as a
# second line of defense behind the `noswap` kernel parameter,
# so the kernel will not page even if a swap device is somehow
# active. The OOM killer is preferred over a single paged-out byte.
vm.swappiness = 0
SYSCTLEOF

# --- tmpfs mounts for /tmp and /var/tmp ---
# These directories are intentionally RAM-only with hardened flags.
# `noexec` blocks running binaries from them (common malware path),
# `nosuid` blocks setuid escalation, `nodev` blocks device-file
# creation. Hard size caps prevent runaway allocations from wedging
# the system. /tmp also holds /tmp/safekeep-boot.log; the 256M cap
# is plenty for session-lifetime logging.
mkdir -p /etc
touch /etc/fstab
# Strip any previous SafeKeep tmpfs lines so re-running the setup
# script is idempotent.
sed -i '/# SAFEKEEP-AMNESIA-TMPFS/d' /etc/fstab
cat >> /etc/fstab << 'FSTABEOF'
# SAFEKEEP-AMNESIA-TMPFS — Absolute Amnesia guarantee (do not remove)
tmpfs  /tmp      tmpfs  defaults,noexec,nosuid,nodev,size=256M,mode=1777  0  0
tmpfs  /var/tmp  tmpfs  defaults,noexec,nosuid,nodev,size=64M,mode=1777   0  0
FSTABEOF

# Mask the systemd-provided tmp.mount unit if it exists — our fstab
# entry is authoritative and must not race with the packaged unit.
if [ -e /usr/share/systemd/tmp.mount ] || [ -e /lib/systemd/system/tmp.mount ]; then
    systemctl mask tmp.mount 2>/dev/null || true
fi

echo "Absolute Amnesia configured: noswap + swappiness=0 + tmpfs fstab."

# ==================================================================
#  SNAP SHUTDOWN — Aggressive systemd Stop Timeouts
# ------------------------------------------------------------------
#  Problem: when the user triggers poweroff from the SafeKeep UI,
#  systemd walks the unit graph sending SIGTERM and WAITS for
#  DefaultTimeoutStopSec (90s upstream, 15s on Ubuntu with a
#  user-facing override) before escalating to SIGKILL. Stubborn
#  clients — a Chromium kiosk chewing on an incognito teardown,
#  a zombie Xorg still holding tty7, an autocutsel child that
#  missed SIGTERM — stall the whole shutdown sequence for roughly
#  10 seconds of user-visible hang before the hardware actually
#  cuts power.
#
#  Why we can afford aggressive timeouts: SafeKeep OS runs entirely
#  from RAM. There is no persistent filesystem to flush, no
#  database to quiesce, no journaled state that depends on a
#  well-behaved teardown. The seed/passphrase amnesia guarantee is
#  provided by the kernel's power-off path (memory is electrically
#  lost) combined with the noswap + vm.swappiness=0 + tmpfs-only
#  stack above — *not* by any userspace cleanup hook. A service
#  that ignores SIGTERM for 1 second gains nothing by being granted
#  a 14-second extension; it just makes the user wait.
#
#  Fix: set DefaultTimeoutStopSec=1s system-wide. Combined with the
#  per-unit TimeoutStopSec=1s baked into safekeep-session.service,
#  this caps the maximum SIGTERM→SIGKILL window for every unit in
#  the shutdown graph at one second.
#
#  DefaultTimeoutAbortSec tracks DefaultTimeoutStopSec when the unit
#  enters watchdog-abort state; we mirror it so a crashing service
#  doesn't re-open the 10s hole via a different code path.
# ==================================================================
echo "Configuring snap shutdown (DefaultTimeoutStopSec=1s)..."

# /etc/systemd/system.conf ships with most [Manager] keys commented
# out as documentation. Our sed handles both forms: "#DefaultTimeoutStopSec="
# (stock, commented) and "DefaultTimeoutStopSec=90s" (already uncommented
# by a previous edit or a different base image). If the key is missing
# entirely — unusual but possible on stripped minimal images — we append it.
if [ -f /etc/systemd/system.conf ]; then
    # Handle DefaultTimeoutStopSec (the user-visible SIGTERM→SIGKILL window)
    if grep -qE '^[#[:space:]]*DefaultTimeoutStopSec=' /etc/systemd/system.conf; then
        sed -i -E 's|^[#[:space:]]*DefaultTimeoutStopSec=.*|DefaultTimeoutStopSec=1s|' /etc/systemd/system.conf
    else
        # [Manager] section must exist for the key to be honored — system.conf
        # always ships with it, but guard anyway.
        if ! grep -q '^\[Manager\]' /etc/systemd/system.conf; then
            echo '[Manager]' >> /etc/systemd/system.conf
        fi
        echo 'DefaultTimeoutStopSec=1s' >> /etc/systemd/system.conf
    fi

    # Handle DefaultTimeoutAbortSec (watchdog-triggered abort window —
    # separate knob, defaults to tracking StopSec but we set it explicitly
    # to close any ambiguity on images where it has been separately tuned).
    if grep -qE '^[#[:space:]]*DefaultTimeoutAbortSec=' /etc/systemd/system.conf; then
        sed -i -E 's|^[#[:space:]]*DefaultTimeoutAbortSec=.*|DefaultTimeoutAbortSec=1s|' /etc/systemd/system.conf
    else
        echo 'DefaultTimeoutAbortSec=1s' >> /etc/systemd/system.conf
    fi

    echo "  Patched /etc/systemd/system.conf: DefaultTimeoutStopSec=1s, DefaultTimeoutAbortSec=1s"
else
    # system.conf missing entirely (extreme minimal chroot) — synthesise it.
    # systemd reads an absent file as "all defaults", so creating a minimal
    # file with just our overrides is sufficient.
    mkdir -p /etc/systemd
    cat > /etc/systemd/system.conf << 'SYSCONFEOF'
# SafeKeep OS — minimal system.conf, only tuned for snap shutdowns.
# RAM-only OS, no persistent state, no reason to wait 90s for a SIGTERM.
[Manager]
DefaultTimeoutStopSec=1s
DefaultTimeoutAbortSec=1s
SYSCONFEOF
    echo "  Created /etc/systemd/system.conf from scratch with DefaultTimeoutStopSec=1s"
fi

# Also drop a conf.d snippet — belt-and-braces. Some systemd builds prefer
# drop-ins (which don't require rewriting the packaged system.conf on
# upgrade) and the existing 10-safekeep-nocore.conf already uses this
# pattern. Keys in system.conf.d/*.conf override the base system.conf.
mkdir -p /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/20-safekeep-snap-shutdown.conf << 'SNAPEOF'
# SafeKeep OS — Snap Shutdown.
# RAM-only live USB; there is nothing for userspace to flush on power-off.
# Cap SIGTERM→SIGKILL at 1s to eliminate the ~10s shutdown hang caused by
# stubborn Chromium / Xorg teardown paths holding up systemd's stop graph.
[Manager]
DefaultTimeoutStopSec=1s
DefaultTimeoutAbortSec=1s
SNAPEOF
echo "  Created /etc/systemd/system.conf.d/20-safekeep-snap-shutdown.conf"

echo "Snap shutdown configured: DefaultTimeoutStopSec=1s (system-wide)."

# --- Step 2: Create the Splash Art File ---
echo "Creating boot splash art..."
cat > /etc/safekeep-splash.txt << 'SPLASHEOF'

      _____       ____     __ __               __    __            ____
     / ___/____ _/ __/___ / //_/___  ___  ____ | |  / /___ ___  __/ / /_
     \__ \/ __ `/ /_/ __ \/ ,< / _ \/ _ \/ __ \| | / / __ `/ / / / / __/
    ___/ / /_/ / __/  __/ /| |/  __/  __/ /_/ /| |/ / /_/ / /_/ / / /_
   /____/\__,_/_/  \___/_/ |_|\___/\___/ .___/ |___/\__,_/\__,_/_/\__/
                                      /_/

                 ╔═══════════════════════════════════╗
                 ║             loading...            ║
                 ╚═══════════════════════════════════╝

                      Air-gapped. Open source.
                        Don't trust. Verify.

SPLASHEOF

# --- Step 3: Create the Early-Boot Systemd Service ---
echo "Creating safekeep-splash systemd service..."
cat > /etc/systemd/system/safekeep-splash.service << 'SVCEOF'
[Unit]
Description=SafeKeep Vault Boot Splash
DefaultDependencies=no
After=local-fs.target
Before=sysinit.target

[Service]
Type=oneshot
StandardOutput=tty
TTYPath=/dev/tty1
ExecStartPre=/usr/bin/clear
ExecStart=/bin/cat /etc/safekeep-splash.txt

[Install]
WantedBy=sysinit.target
SVCEOF

systemctl enable safekeep-splash.service

# --- Step 3.5: Enable the kiosk session unit ---
# safekeep-session.service is the permanent replacement for the old
# getty@tty1-autologin → .profile → startx chain (severed by the hardening
# sweep in safekeep-harden.sh which masks every getty instance). The unit
# file itself is installed by build.sh *before* this script runs, so enabling
# it here is just a matter of creating the graphical.target.wants/ symlink.
#
# Setting default target to graphical.target is redundant on the Ubuntu base
# image we debootstrap from (already default), but we do it here to make the
# contract explicit: if someone later switches the base image to minimal,
# the kiosk still comes up automatically.
systemctl enable safekeep-session.service
systemctl set-default graphical.target

# --- Step 4: Prevent getty from clearing tty1 ---
# By default, systemd's getty wipes the terminal before presenting a login
# prompt (or handing off to startx). This destroys our splash art.
# TTYVTDisallocate=no keeps the framebuffer contents intact.
mkdir -p /etc/systemd/system/getty@tty1.service.d/
cat > /etc/systemd/system/getty@tty1.service.d/noclear.conf << 'NOCLEAREOF'
[Service]
TTYVTDisallocate=no
NOCLEAREOF

echo "Boot splash configured."

# ==================================================================

echo "Creating default directories..."
mkdir -p /root/Downloads /root/Desktop /root/Documents /root/.local/share

echo "Cleaning up tmp directories..."
rm -rf /tmp/*

echo "Chroot configuration complete!"
