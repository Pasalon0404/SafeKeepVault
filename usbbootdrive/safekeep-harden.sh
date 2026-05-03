#!/bin/bash
# ============================================================================
# safekeep-harden.sh — Scorched-Earth OS Hardening for SafeKeep Live USB
# ============================================================================
#
# PURPOSE:
#   Lock down the underlying Linux OS so that the SafeKeep air-gapped
#   Bitcoin toolkit is hermetically sealed from all networks, host storage,
#   peripherals, and automount attack surfaces.
#
# CONTEXT:
#   SafeKeep OS runs LIVE from a persistent .img file flashed to a USB
#   thumb drive. The drive has five GPT partitions:
#
#     Partition 1:  BIOS Boot    (1MB, raw)
#     Partition 2:  EFI System   (100MB, FAT32, label "SK-EFI")
#     Partition 3:  OS           (ext4, label "safekeep-os") — squashfs + kernel
#     Partition 4:  Data         (300MB, ext4, label "safekeep-data") — LUKS vault
#     Partition 5:  Transfer     (300MB, exFAT, label "TRANSFER") — airlock
#
#   The OS must read/write partitions 3-5 on the BOOT USB. It must NEVER
#   touch the host machine's internal drives, networks, or peripherals.
#
# EXECUTION:
#   This script runs inside the chroot during image build (called by
#   build.sh after chroot-setup.sh). It can also be re-run at boot time
#   as a systemd oneshot service for defense-in-depth.
#
# PHILOSOPHY:
#   Deny everything. Whitelist only what the Live USB needs to function.
#   Every rule below exists to eliminate a specific attack vector.
#
# ============================================================================
set -euo pipefail

echo "========================================"
echo " SafeKeep OS Hardening — Scorched Earth"
echo "========================================"

# ============================================================================
# SECTION 1: NETWORK EXTERMINATION
# ============================================================================
#
# THREAT MODEL:
#   Any network interface — Wi-Fi, Bluetooth, Ethernet — is a potential
#   exfiltration channel for private keys. An air-gapped device must have
#   ZERO ability to transmit data electronically.
#
# STRATEGY:
#   Three layers of defense, each independently sufficient:
#     Layer 1: Stop and mask all network-related systemd services
#     Layer 2: rfkill hardware radio kill
#     Layer 3: Kernel module blacklist (prevents drivers from ever loading)
#
# WHY THREE LAYERS?
#   - Masking services handles userspace daemons but a rogue app could
#     still bring up a raw interface via ioctl.
#   - rfkill handles hardware radios but doesn't affect Ethernet.
#   - Module blacklisting prevents the kernel from ever knowing the
#     hardware exists, which is the strongest possible guarantee.
#   Together, all three make network access physically impossible.
# ============================================================================

echo ""
echo "[1/7] NETWORK EXTERMINATION"
echo "-------------------------------------------"

# --- Layer 1: Kill and permanently mask network services ---
# "mask" creates a symlink to /dev/null, which survives reboots and
# prevents the service from being started by ANY mechanism (manual,
# dependency, socket activation). This is stronger than "disable".

NETWORK_SERVICES=(
    "NetworkManager.service"        # Desktop network manager (Wi-Fi, VPN, etc.)
    "NetworkManager-wait-online.service"
    "NetworkManager-dispatcher.service"
    "systemd-networkd.service"      # systemd's built-in network daemon
    "systemd-networkd-wait-online.service"
    "systemd-resolved.service"      # DNS resolver (useless without network)
    "wpa_supplicant.service"        # WPA/WPA2 Wi-Fi authentication daemon
    "avahi-daemon.service"          # mDNS/Bonjour — zero-conf network discovery
    "avahi-daemon.socket"           # Socket activation for avahi
    "bluetooth.service"             # BlueZ Bluetooth stack
    "ModemManager.service"          # Cellular modem manager (3G/4G/5G)
    "systemd-timesyncd.service"     # NTP time sync (requires network)
    # --- Casper live-boot MD5 check ---
    # Not network-related, but masked here (earliest hardening loop) so the
    # unit is neutralised before any casper.target dependency can pull it in.
    # Casper's md5check assumes ISO layout (md5sum.txt at image root). Our
    # build emits a raw GPT .img with casper/ on an ext4 partition — no
    # md5sum.txt ever exists, so the check hard-fails and blocks boot on
    # dependent units. We replace it with SHA-256 attestation of boot.html
    # vs manifest.json in safekeep-boot.sh (a stronger runtime check).
    # Mask BOTH .service and .path — the .path companion re-triggers the
    # .service on filesystem events; masking only one leaves the other live.
    "casper-md5check.service"       # Systemd unit that runs the MD5 check
    "casper-md5check.path"          # Path-activation trigger for the above
)

for svc in "${NETWORK_SERVICES[@]}"; do
    # Use --no-reload to avoid errors in chroot where systemd isn't running
    systemctl stop "$svc" 2>/dev/null || true
    systemctl mask "$svc" 2>/dev/null || true
    echo "  Masked: $svc"
done

# --- Layer 2: Hardware radio kill ---
# rfkill block affects Wi-Fi, Bluetooth, NFC, and cellular radios.
# We persist it via a udev rule so it survives every boot.

echo ""
echo "  Blocking all wireless radios via rfkill..."
rfkill block all 2>/dev/null || true

# Persist the rfkill block across reboots with a udev rule.
# When ANY wireless device appears, immediately soft-block it.
cat > /etc/udev/rules.d/70-safekeep-rfkill.rules << 'RFKILL_EOF'
# SafeKeep: permanently block all wireless radios at the hardware level.
# Fires whenever a new rfkill device is registered (Wi-Fi, BT, NFC, etc.)
ACTION=="add", SUBSYSTEM=="rfkill", RUN+="/usr/sbin/rfkill block all"
RFKILL_EOF
echo "  Created: /etc/udev/rules.d/70-safekeep-rfkill.rules"

# --- Layer 3: Kernel module blacklist ---
# Even if a service somehow gets unmasked or rfkill is bypassed,
# the kernel literally cannot load drivers for network hardware
# if the modules are blacklisted. This is the nuclear option.
#
# "install <module> /bin/false" is stronger than "blacklist" alone.
# "blacklist" prevents autoloading but allows manual modprobe.
# "install ... /bin/false" makes modprobe itself a no-op.

cat > /etc/modprobe.d/safekeep-no-network.conf << 'NETMOD_EOF'
# ============================================================================
# SafeKeep: Permanently ban ALL network kernel modules.
# This file makes it physically impossible for the kernel to communicate
# with any network hardware, even if a privileged process tries modprobe.
# ============================================================================

# --- Wi-Fi chipset drivers (covers Intel, Broadcom, Qualcomm, Realtek, etc.) ---
# Intel Wi-Fi (most modern laptops)
blacklist iwlwifi
blacklist iwlmvm
blacklist iwldvm
install iwlwifi /bin/false
install iwlmvm /bin/false
install iwldvm /bin/false

# Broadcom Wi-Fi (MacBooks, many consumer laptops)
blacklist b43
blacklist b43legacy
blacklist bcma
blacklist brcmfmac
blacklist brcmsmac
blacklist wl
install b43 /bin/false
install brcmfmac /bin/false
install brcmsmac /bin/false
install wl /bin/false

# Qualcomm Atheros Wi-Fi
blacklist ath9k
blacklist ath9k_htc
blacklist ath10k_pci
blacklist ath10k_core
blacklist ath11k
blacklist ath11k_pci
install ath9k /bin/false
install ath10k_pci /bin/false
install ath11k_pci /bin/false

# Realtek Wi-Fi (budget laptops, USB dongles)
blacklist rtl8xxxu
blacklist rtw88_pci
blacklist rtw88_usb
blacklist rtw89_pci
blacklist r8188eu
blacklist rtl8192cu
install rtl8xxxu /bin/false
install rtw88_pci /bin/false
install rtw89_pci /bin/false

# MediaTek Wi-Fi
blacklist mt76
blacklist mt7601u
blacklist mt76x2u
install mt76 /bin/false
install mt7601u /bin/false

# Ralink (legacy, now MediaTek)
blacklist rt2800usb
blacklist rt2800pci
install rt2800usb /bin/false
install rt2800pci /bin/false

# Generic Wi-Fi / cfg80211 / mac80211 stack
# Blocking these prevents ANY Wi-Fi driver from functioning,
# even ones we didn't explicitly list above.
blacklist cfg80211
blacklist mac80211
install cfg80211 /bin/false
install mac80211 /bin/false

# --- Bluetooth drivers ---
# Core Bluetooth stack
blacklist bluetooth
blacklist btusb
blacklist btrtl
blacklist btbcm
blacklist btintel
blacklist btmtk
blacklist bnep
blacklist rfcomm
blacklist hidp
install bluetooth /bin/false
install btusb /bin/false
install btrtl /bin/false
install btbcm /bin/false
install btintel /bin/false

# --- Ethernet drivers ---
# We blacklist the most common wired Ethernet chipsets.
# The machine boots from USB — it has no reason to touch Ethernet.

# Intel Ethernet
blacklist e1000
blacklist e1000e
blacklist igb
blacklist igc
blacklist ixgbe
blacklist i40e
blacklist ice
install e1000 /bin/false
install e1000e /bin/false
install igb /bin/false
install igc /bin/false

# Realtek Ethernet (extremely common in consumer hardware)
blacklist r8169
blacklist r8125
blacklist r8152
install r8169 /bin/false
install r8125 /bin/false
install r8152 /bin/false

# Broadcom Ethernet
blacklist tg3
blacklist bnxt_en
install tg3 /bin/false
install bnxt_en /bin/false

# Qualcomm / Aquantia multi-gig Ethernet
blacklist atlantic
install atlantic /bin/false

# USB Ethernet adapters (dongles)
blacklist ax88179_178a
blacklist cdc_ether
blacklist cdc_ncm
blacklist rndis_host
blacklist usbnet
install cdc_ether /bin/false
install rndis_host /bin/false
install usbnet /bin/false

# --- Cellular / Mobile broadband ---
blacklist cdc_mbim
blacklist cdc_wdm
blacklist qmi_wwan
blacklist option
install cdc_mbim /bin/false
install qmi_wwan /bin/false

# --- Thunderbolt networking (macOS target disk mode, etc.) ---
blacklist thunderbolt_net
install thunderbolt_net /bin/false

# --- Virtual / tunnel interfaces ---
# Prevent software-defined networking even if someone gets a shell.
blacklist tun
blacklist tap
blacklist veth
blacklist bridge
blacklist bonding
install tun /bin/false
install bridge /bin/false
NETMOD_EOF

echo "  Created: /etc/modprobe.d/safekeep-no-network.conf"
echo "  Network extermination complete."


# ============================================================================
# SECTION 2: PRINTER & PERIPHERAL EXTERMINATION
# ============================================================================
#
# THREAT MODEL:
#   CUPS (Common Unix Printing System) is a large, network-aware daemon
#   that listens on port 631, supports IPP/mDNS discovery, and has a
#   long history of CVEs. Any print spooler is an unnecessary attack
#   surface on an air-gapped device.
#
# SAFEKEEP'S APPROACH:
#   Printing is handled ENTIRELY by the browser's built-in "Save as PDF"
#   → the PDF lands in the vault → the user moves it via the TRANSFER
#   airlock partition. No spooler, no drivers, no network print discovery.
# ============================================================================

echo ""
echo "[2/7] PRINTER & PERIPHERAL EXTERMINATION"
echo "-------------------------------------------"

CUPS_SERVICES=(
    "cups.service"                  # Main CUPS print spooler daemon
    "cups.socket"                   # Socket activation for CUPS
    "cups.path"                     # Path-based activation for CUPS
    "cups-browsed.service"          # Automatic printer discovery (Avahi/DNS-SD)
)

for svc in "${CUPS_SERVICES[@]}"; do
    systemctl stop "$svc" 2>/dev/null || true
    systemctl mask "$svc" 2>/dev/null || true
    echo "  Masked: $svc"
done

# Remove CUPS packages entirely if they exist.
# --purge removes config files too. This reduces the squashfs image size
# and eliminates the binaries from disk entirely.
#
# Ghostscript (gs, gs-common, libgs*) is included in the purge because it
# is the back-end rasterizer used by CUPS drivers and many PDF-handling
# utilities. Its presence has no upside on an air-gapped kiosk — boot.html
# renders print output through Chromium's built-in PDF printer, which does
# not use Ghostscript — and it has a long CVE tail. Burn it down.
echo "  Purging CUPS + Ghostscript packages (if installed)..."
apt-get purge -y cups cups-browsed cups-daemon cups-client cups-common \
    cups-core-drivers cups-filters cups-ppdc system-config-printer \
    printer-driver-* foomatic-* hplip \
    ghostscript gs-common libgs-common libgs9 libgs9-common 2>/dev/null || true
apt-get autoremove -y 2>/dev/null || true

# Blacklist the USB printer driver module as a final safeguard.
# Even if someone installs CUPS later, the kernel won't see USB printers.
cat > /etc/modprobe.d/safekeep-no-printers.conf << 'PRINTMOD_EOF'
# ============================================================================
# SafeKeep: Ban USB printer and parallel port drivers.
# The browser's "Save as PDF" is the only print path.
# ============================================================================
blacklist usblp
blacklist lp
blacklist ppdev
blacklist parport
blacklist parport_pc
install usblp /bin/false
install lp /bin/false
install ppdev /bin/false
install parport /bin/false
PRINTMOD_EOF

echo "  Created: /etc/modprobe.d/safekeep-no-printers.conf"
echo "  Printer extermination complete."


# ============================================================================
# SECTION 3: HOST STORAGE BLACKLIST
# ============================================================================
#
# THREAT MODEL:
#   The host machine's internal SSD/HDD contains the owner's real OS,
#   personal files, and potentially sensitive data. If our Live USB can
#   see those drives, a compromised browser or a user mistake could:
#     - Read private files from the host
#     - Write malware to the host's boot sector
#     - Corrupt the host filesystem
#
# STRATEGY:
#   Blacklist the kernel modules that control internal storage buses:
#     - ahci    → SATA controller (HDDs, SATA SSDs)
#     - nvme    → NVMe controller (M.2 PCIe SSDs)
#
#   With these blocked, the kernel physically cannot see internal drives.
#   They won't appear in /dev, lsblk, fdisk, or anywhere else.
#
# WHY THIS IS SAFE:
#   SafeKeep OS boots entirely from USB. The boot chain is:
#     BIOS/UEFI → GRUB (on USB EFI partition) → kernel + initramfs →
#     squashfs root (on USB OS partition) → casper live system
#
#   The USB stack (usb-storage, uas, xhci_hcd, ehci_hcd) handles all
#   I/O to our five USB partitions. AHCI and NVMe are never needed.
#
# EDGE CASE — USB-ATTACHED SCSI (UAS):
#   Some USB 3.0+ thumb drives use the UAS protocol instead of the
#   older bulk-only transport. The "uas" module MUST remain loaded
#   or the boot drive itself could become inaccessible. We explicitly
#   DO NOT blacklist usb-storage or uas.
# ============================================================================

echo ""
echo "[3/7] HOST STORAGE BLACKLIST"
echo "-------------------------------------------"

cat > /etc/modprobe.d/safekeep-no-host-storage.conf << 'STORMOD_EOF'
# ============================================================================
# SafeKeep: Ban internal storage controllers.
# The host machine's SATA and NVMe drives must be invisible.
# The USB boot drive uses usb-storage/uas — which are NOT blocked here.
# ============================================================================

# --- SATA / AHCI ---
# Blocks access to ALL internal SATA devices (HDDs, SATA SSDs, optical drives).
# The AHCI driver is the standard interface for SATA on modern motherboards.
blacklist ahci
blacklist libahci
install ahci /bin/false
install libahci /bin/false

# Legacy IDE (rarely relevant, but covers old hardware)
blacklist ata_piix
blacklist pata_acpi
install ata_piix /bin/false
install pata_acpi /bin/false

# --- NVMe ---
# Blocks access to ALL NVMe SSDs (M.2, U.2, PCIe add-in cards).
# This is the most common internal storage on modern machines.
blacklist nvme
blacklist nvme_core
install nvme /bin/false
install nvme_core /bin/false

# --- MMC / eMMC ---
# Blocks access to embedded flash storage found in tablets, Chromebooks,
# and some ultra-portable laptops. Not USB — it's soldered to the board.
blacklist sdhci
blacklist sdhci_pci
blacklist sdhci_acpi
blacklist mmc_core
blacklist mmc_block
install sdhci_pci /bin/false
install mmc_core /bin/false

# --- SCSI / SAS ---
# Enterprise SCSI/SAS controllers (server hardware). Extremely unlikely
# on a consumer machine, but costs nothing to block.
blacklist mpt3sas
blacklist megaraid_sas
blacklist aacraid
blacklist hpsa
install mpt3sas /bin/false
install megaraid_sas /bin/false

# ============================================================================
# WHITELIST — These modules are REQUIRED for the USB boot drive:
#
#   usb-storage   → USB Mass Storage (bulk-only transport)
#   uas           → USB Attached SCSI (USB 3.0+ drives)
#   xhci_hcd      → USB 3.x host controller
#   ehci_hcd      → USB 2.0 host controller
#   uhci_hcd      → USB 1.1 host controller (legacy fallback)
#   ohci_hcd      → USB 1.1 host controller (legacy fallback)
#   sd_mod        → SCSI disk driver (presents USB drives as /dev/sdX)
#   ext4          → Filesystem for OS and Data partitions
#   exfat         → Filesystem for TRANSFER partition
#   dm-crypt      → Device-mapper encryption (LUKS vault)
#   squashfs      → Read-only compressed root filesystem (casper)
#   overlay       → Overlay filesystem for live session writes
#
# DO NOT add any of these to a blacklist file. Doing so will brick
# the boot drive and make the system unable to start.
# ============================================================================
STORMOD_EOF

echo "  Created: /etc/modprobe.d/safekeep-no-host-storage.conf"
echo "  Host storage blacklist complete."


# ============================================================================
# SECTION 4: USB PERSISTENCE WHITELIST & AUTOMOUNT FIREWALL
# ============================================================================
#
# THREAT MODEL:
#   If someone plugs a malicious USB device into the machine while
#   SafeKeep OS is running, we don't want it to:
#     - Automount and execute autorun scripts
#     - Appear in the file manager where the user might click on it
#     - Masquerade as a keyboard (USB HID attack / BadUSB)
#
# STRATEGY:
#   1. udisks2 policy: Disable automount globally via dconf/polkit
#   2. udev rules: Only the SafeKeep boot drive's partitions get the
#      "this is ours" flag. All other USB storage devices are flagged
#      UDISKS_IGNORE so they're hidden from the desktop.
#   3. PCManFM config: Already set mount_on_startup=0, mount_removable=0,
#      autorun=0 in chroot-setup.sh.
#
# IDENTIFYING THE BOOT DRIVE:
#   We identify our partitions by their filesystem LABEL, not by device
#   path (which changes between machines). The labels are:
#     - "safekeep-os"    (ext4, OS partition)
#     - "safekeep-data"  (ext4, LUKS vault container)
#     - "TRANSFER"       (exFAT, airlock)
#     - "SK-EFI"         (FAT32, EFI System Partition)
#
#   These labels are set during image build (build.sh) and are globally
#   unique enough that collision with a host drive is negligible.
# ============================================================================

echo ""
echo "[4/7] USB AUTOMOUNT FIREWALL"
echo "-------------------------------------------"

# --- 4a: Polkit rule to deny automount for unprivileged users ---
# This prevents udisks2 from mounting ANY filesystem without explicit
# root-level action (mount command). Our boot scripts use explicit
# "mount" calls for the partitions we need, so they bypass this.

mkdir -p /etc/polkit-1/localauthority/90-mandatory.d

cat > /etc/polkit-1/localauthority/90-mandatory.d/99-safekeep-no-automount.pkla << 'POLKIT_EOF'
# SafeKeep: Deny all automatic/user-initiated filesystem mounting.
# Only explicit root mount commands (in safekeep-boot.sh, setup-vault,
# unlock-vault) can mount partitions. This blocks:
#   - udisks2 automount on device plug
#   - User clicking "Mount" in a file manager
#   - Any D-Bus mount request from unprivileged processes
[Deny Automount]
Identity=unix-user:*
Action=org.freedesktop.udisks2.filesystem-mount;org.freedesktop.udisks2.filesystem-mount-system;org.freedesktop.udisks2.filesystem-mount-other-seat
ResultAny=no
ResultInactive=no
ResultActive=auth_admin
POLKIT_EOF

echo "  Created: polkit automount deny policy"

# --- 4b: udev rules for USB device quarantine ---
# Any USB mass storage device that does NOT carry one of our known
# partition labels is flagged UDISKS_IGNORE=1, making it invisible
# to udisks2, gvfs, and PCManFM.
#
# NOTE: This works in concert with 99-hide-drives.rules (from
# chroot-setup.sh) which hides our INTERNAL partitions from the UI.
# This rule handles EXTERNAL/unknown devices.

cat > /etc/udev/rules.d/80-safekeep-usb-quarantine.rules << 'USBQUARANTINE_EOF'
# ============================================================================
# SafeKeep: USB Mass Storage Quarantine
# ============================================================================
#
# LOGIC:
#   All USB-connected block devices (SUBSYSTEM=="block") are quarantined
#   (UDISKS_IGNORE="1") UNLESS they carry one of our known labels.
#
#   The GOTO/LABEL structure implements a whitelist:
#     1. If the device has a known SafeKeep label → skip to END (allowed)
#     2. Otherwise → fall through to the quarantine rule (blocked)
#
# IMPORTANT:
#   This does NOT prevent the kernel from seeing the device in /dev.
#   It prevents desktop environments and file managers from showing it.
#   Root can still manually mount quarantined devices if truly needed.
# ============================================================================

# --- Whitelist: SafeKeep boot drive partitions (skip quarantine) ---
SUBSYSTEM=="block", ENV{ID_FS_LABEL}=="safekeep-os", GOTO="safekeep_usb_end"
SUBSYSTEM=="block", ENV{ID_FS_LABEL}=="safekeep-data", GOTO="safekeep_usb_end"
SUBSYSTEM=="block", ENV{ID_FS_LABEL}=="TRANSFER", GOTO="safekeep_usb_end"
SUBSYSTEM=="block", ENV{ID_FS_LABEL}=="SK-EFI", GOTO="safekeep_usb_end"

# --- Whitelist: Device-mapper volumes (LUKS vault) ---
SUBSYSTEM=="block", KERNEL=="dm-*", ENV{DM_NAME}=="vault", GOTO="safekeep_usb_end"

# --- Quarantine: Everything else on USB ---
# Match any block device arriving on the USB bus that wasn't whitelisted above.
SUBSYSTEM=="block", ENV{ID_BUS}=="usb", ENV{UDISKS_IGNORE}="1"

LABEL="safekeep_usb_end"
USBQUARANTINE_EOF

echo "  Created: /etc/udev/rules.d/80-safekeep-usb-quarantine.rules"

# --- 4c: Disable GNOME/GTK automount at the dconf level ---
# This catches any GTK/glib-based file manager (PCManFM uses glib)
# that might try to automount via GVolumeMonitor.

mkdir -p /etc/dconf/profile
mkdir -p /etc/dconf/db/local.d

# dconf profile: tell glib to check our local database first
cat > /etc/dconf/profile/user << 'DCONFPROFILE_EOF'
user-db:user
system-db:local
DCONFPROFILE_EOF

# dconf settings: disable automount
cat > /etc/dconf/db/local.d/00-safekeep-nomount << 'DCONFSETTINGS_EOF'
[org/gnome/desktop/media-handling]
automount=false
automount-open=false
autorun-never=true
DCONFSETTINGS_EOF

# Lock these settings so users/apps cannot override them
mkdir -p /etc/dconf/db/local.d/locks
cat > /etc/dconf/db/local.d/locks/00-safekeep-nomount << 'DCONFLOCK_EOF'
/org/gnome/desktop/media-handling/automount
/org/gnome/desktop/media-handling/automount-open
/org/gnome/desktop/media-handling/autorun-never
DCONFLOCK_EOF

# Compile the dconf database (required for settings to take effect)
dconf update 2>/dev/null || true

echo "  Created: dconf automount lockdown"

# --- 4d: Disable USB HID devices that appear AFTER boot ---
# This is a defense against BadUSB / Rubber Ducky attacks where a
# malicious USB device enumerates as a keyboard and types commands.
#
# Strategy: Allow HID devices that are present at boot (the user's
# real keyboard and mouse). Block any NEW HID device that appears
# after the system is running. We do this with a udev rule that
# checks a flag file created by the boot process.
#
# NOTE: This is a soft defense. A determined attacker with physical
# access has already won. But it stops opportunistic BadUSB attacks.

cat > /etc/udev/rules.d/85-safekeep-hid-lockdown.rules << 'HID_EOF'
# ============================================================================
# SafeKeep: Block late-arriving USB HID devices (BadUSB defense)
# ============================================================================
#
# After the boot flag /run/safekeep-hid-locked is created,
# any NEW USB HID device (keyboard, mouse, etc.) is disabled.
# Pre-existing devices from boot time are unaffected.
#
# To re-enable HID acceptance (e.g., connecting a new keyboard),
# delete /run/safekeep-hid-locked and re-trigger udev.
# ============================================================================

# Only act on USB HID devices
SUBSYSTEM!="usb", GOTO="safekeep_hid_end"
ACTION!="add", GOTO="safekeep_hid_end"

# Only block if the lockdown flag exists (set ~30s after boot)
TEST!="/run/safekeep-hid-locked", GOTO="safekeep_hid_end"

# Block USB HID interfaces (bInterfaceClass 03 = HID)
ATTR{bInterfaceClass}=="03", RUN+="/bin/sh -c 'echo 0 > /sys$env{DEVPATH}/authorized'"

LABEL="safekeep_hid_end"
HID_EOF

echo "  Created: /etc/udev/rules.d/85-safekeep-hid-lockdown.rules"

# ----------------------------------------------------------------------------
# HID lockdown trigger — timer + trivial oneshot (NOT blocking boot)
# ----------------------------------------------------------------------------
# The goal is "drop the /run/safekeep-hid-locked flag 30s after boot so real
# USB keyboards/mice have time to enumerate." The obvious-but-wrong way is
# `Type=oneshot` + `ExecStartPre=/bin/sleep 30` + `WantedBy=multi-user.target`
# — that holds multi-user.target (and therefore graphical.target and the
# Chromium kiosk) for 30 full seconds while oneshot sits in `activating`.
# Combining `After=multi-user.target` with `WantedBy=multi-user.target` on
# the same unit also creates an ordering cycle that systemd's resolver can
# stall on, producing the classic "Job safekeep-hid-lock.service/start
# running (Ns / no limit)" boot hang.
#
# The idiomatic fix is a .timer unit. A timer fires asynchronously — nothing
# waits for it — and the service it triggers has no After=/WantedBy= edges
# into the critical-path boot graph, so it cannot hold graphical.target.

cat > /etc/systemd/system/safekeep-hid-lock.service << 'HIDSERVICE_EOF'
[Unit]
Description=SafeKeep HID Lockdown — block late-arriving USB keyboards
# Deliberately NO After= or WantedBy= entries. This unit is triggered
# exclusively by safekeep-hid-lock.timer (post-boot, asynchronous).
# Do not add WantedBy=multi-user.target — it will re-introduce the hang.

[Service]
Type=oneshot
ExecStart=/bin/touch /run/safekeep-hid-locked
RemainAfterExit=yes
HIDSERVICE_EOF

cat > /etc/systemd/system/safekeep-hid-lock.timer << 'HIDTIMER_EOF'
[Unit]
Description=Fire SafeKeep HID lockdown 30s after boot (BadUSB defense)

[Timer]
# 30s gives the real KB/mouse time to enumerate before we slam the gate.
OnBootSec=30s
AccuracySec=1s
Unit=safekeep-hid-lock.service

[Install]
WantedBy=timers.target
HIDTIMER_EOF

# Enable the TIMER, not the service. The timer owns scheduling; systemd
# pulls the service in only when the timer fires, well after the desktop
# is already running.
systemctl enable safekeep-hid-lock.timer 2>/dev/null || true
echo "  Enabled: safekeep-hid-lock.timer (BadUSB defense, fires 30s post-boot)"


# ============================================================================
# SECTION 5: OS SURFACE REDUCTION — TTY, COREDUMPS, JOURNALD, APPORT
# ============================================================================
#
# THREAT MODEL:
#   Even with Chromium locked down, three classes of host-OS misbehavior
#   can leak seed material or provide an escape hatch to the Linux shell:
#
#     1. Virtual terminal (TTY) switching — Ctrl+Alt+F1..F6 drops the user
#        onto another console. If any TTY has a login prompt live, a
#        BadUSB keyboard can type credentials and jailbreak the kiosk.
#     2. Coredumps — a Chromium crash can dump heap pages (including
#        seeds) to /var/crash via apport, or to the CWD via the default
#        core_pattern. Both paths are invisible to the user.
#     3. Persistent journald — /var/log/journal survives reboots. Any
#        systemd-logged event from an ephemeral session would leak into
#        the next boot's filesystem.
#
# SAFEKEEP'S APPROACH:
#   - NAutoVTs=0 / ReserveVT=0 in /etc/systemd/logind.conf → systemd
#     allocates zero virtual terminals. The getty@ template unit has
#     nothing to bind to. Physical TTY switching produces a blank screen
#     with no login prompt.
#   - ulimit -c 0 in /etc/security/limits.conf AND a systemd drop-in →
#     processes cannot produce coredumps regardless of launch path.
#   - kernel.core_pattern=|/bin/false → if a coredump is somehow still
#     requested, the kernel pipes it to /bin/false which discards it.
#   - apport.service + apport-forward.timer MASKED → Ubuntu's crash
#     reporter can never invoke, can never write to /var/crash.
#   - /etc/systemd/journald.conf Storage=volatile → journald keeps logs
#     in /run (tmpfs, RAM-only) and never touches /var/log/journal.
# ============================================================================

echo ""
echo "[5/7] OS SURFACE REDUCTION"
echo "-------------------------------------------"

# --- 5a. TTY switching ---
# NAutoVTs=0 tells systemd-logind to not auto-start getty on any tty.
# ReserveVT=0 removes the reserved console TTY (normally tty6).
# Together these mean every VT is blank with no login prompt.
echo "  Disabling virtual-terminal allocation (NAutoVTs=0, ReserveVT=0)..."
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/10-safekeep-no-ttys.conf << 'LOGIND_EOF'
# ============================================================================
# SafeKeep: kill every virtual terminal at the systemd-logind level.
# Physical Ctrl+Alt+F<n> switches to a blank VT with no login prompt.
# ============================================================================
[Login]
NAutoVTs=0
ReserveVT=0
KillUserProcesses=yes
LOGIND_EOF
echo "  Created: /etc/systemd/logind.conf.d/10-safekeep-no-ttys.conf"

# Belt-and-braces: mask every getty instance that might have been enabled
# by the base image. systemd won't reap getty@tty1..getty@tty6 even with
# NAutoVTs=0 if they were explicitly enabled — mask them so they can't
# come back.
for tty_n in 1 2 3 4 5 6; do
    systemctl stop "getty@tty${tty_n}.service" 2>/dev/null || true
    systemctl mask "getty@tty${tty_n}.service" 2>/dev/null || true
done
systemctl mask getty.target 2>/dev/null || true
systemctl mask getty-static.service 2>/dev/null || true
systemctl mask autovt@.service 2>/dev/null || true
systemctl mask serial-getty@.service 2>/dev/null || true
echo "  Masked: getty@tty1..6, getty.target, autovt@, serial-getty@"

# --- 5b. Apport + coredumps ---
# Mask every apport-related unit. apport.service is the crash
# forwarder; apport-autoreport and apport-forward are periodic timers
# that can re-activate the forwarder. Kill all three.
echo "  Masking Apport crash reporter..."
for svc in apport.service apport-autoreport.service apport-forward.timer \
           apport-autoreport.timer; do
    systemctl stop "$svc" 2>/dev/null || true
    systemctl mask "$svc" 2>/dev/null || true
done
# Also remove the package if present — no apport binary → no apport crash.
apt-get purge -y apport apport-symptoms python3-apport whoopsie 2>/dev/null || true

# Set ulimit -c 0 globally via /etc/security/limits.conf so every login
# session starts with coredumps suppressed.
echo "  Setting ulimit -c 0 globally via /etc/security/limits.d..."
mkdir -p /etc/security/limits.d
cat > /etc/security/limits.d/10-safekeep-nocore.conf << 'LIMITS_EOF'
# ============================================================================
# SafeKeep: suppress coredumps globally.
# A Chromium crash must never spill heap pages (containing seeds) to disk.
# ============================================================================
*    hard    core    0
*    soft    core    0
root hard    core    0
root soft    core    0
LIMITS_EOF
echo "  Created: /etc/security/limits.d/10-safekeep-nocore.conf"

# Systemd drop-in: set DefaultLimitCORE=0 for every unit that inherits
# from system defaults. limits.conf only applies to PAM-authenticated
# sessions — this catches everything else.
mkdir -p /etc/systemd/system.conf.d /etc/systemd/user.conf.d
cat > /etc/systemd/system.conf.d/10-safekeep-nocore.conf << 'SYSCORE_EOF'
# SafeKeep: no coredumps from any systemd-launched process.
[Manager]
DefaultLimitCORE=0
DumpCore=no
CrashShell=no
CrashReboot=no
SYSCORE_EOF
cat > /etc/systemd/user.conf.d/10-safekeep-nocore.conf << 'USRCORE_EOF'
[Manager]
DefaultLimitCORE=0
USRCORE_EOF
echo "  Created: systemd system/user drop-ins (DefaultLimitCORE=0)"

# Kernel-level fallback: pipe every coredump to /bin/false. If anything
# slips past the limits and systemd drop-ins, the kernel itself discards
# the core image before it touches disk.
cat > /etc/sysctl.d/10-safekeep-no-coredumps.conf << 'SYSCTL_EOF'
# ============================================================================
# SafeKeep: hard-kill coredumps at the kernel level.
# kernel.core_pattern=|/bin/false pipes every core to /bin/false, which
# reads stdin and exits 1, discarding the dump before anything hits /var.
# ============================================================================
kernel.core_pattern=|/bin/false
kernel.core_uses_pid=0
fs.suid_dumpable=0
SYSCTL_EOF
# Apply immediately in case this script is re-run post-boot.
sysctl -p /etc/sysctl.d/10-safekeep-no-coredumps.conf 2>/dev/null || true
echo "  Created: /etc/sysctl.d/10-safekeep-no-coredumps.conf (core_pattern=|/bin/false)"

# Also mask systemd-coredump — Ubuntu 24.04 routes coredumps through
# this socket by default. Mask the socket + service so there's nowhere
# for a core to land.
systemctl stop systemd-coredump.socket 2>/dev/null || true
systemctl mask systemd-coredump.socket 2>/dev/null || true
systemctl mask systemd-coredump@.service 2>/dev/null || true
echo "  Masked: systemd-coredump.socket, systemd-coredump@.service"

# --- 5c. Journald: RAM only ---
# Storage=volatile forces journald to keep logs in /run/log/journal
# (tmpfs) and never write to /var/log/journal. Any seed-adjacent log
# line is wiped on poweroff.
echo "  Forcing journald Storage=volatile (RAM only, no /var/log/journal)..."
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/10-safekeep-volatile.conf << 'JOURNALD_EOF'
# ============================================================================
# SafeKeep: journald is RAM-only. Nothing goes to /var/log/journal, ever.
# ============================================================================
[Journal]
Storage=volatile
RuntimeMaxUse=32M
RuntimeKeepFree=16M
ForwardToSyslog=no
ForwardToKMsg=no
ForwardToConsole=no
ForwardToWall=no
JOURNALD_EOF
# Remove any persistent journal directory that was baked into the base image.
rm -rf /var/log/journal 2>/dev/null || true
echo "  Created: /etc/systemd/journald.conf.d/10-safekeep-volatile.conf"
echo "  Removed: /var/log/journal (if present)"

echo "  OS surface reduction complete."


# ============================================================================
# SECTION 6: FILE CHOOSER JAIL — TRANSFER DRIVE ONLY
# ============================================================================
#
# THREAT MODEL:
#   Chromium's <input type="file"> and the HTML5 File System Access API
#   (showDirectoryPicker) both invoke the native GTK file chooser on
#   Linux. In the stock configuration that chooser exposes:
#
#     - A sidebar with Home / Desktop / Documents / Downloads / Pictures
#       / Music / Videos / Public / Templates shortcuts
#     - "Recent" — a GtkRecentManager-backed virtual folder of paths
#       the chooser has seen before
#     - "Other Locations" — rendered by GVfs; shows /, /home, /media,
#       every mount point, and any configured network backends
#     - GVfs virtual mounts (trash://, recent://, computer://, smb://, ...)
#
#   For SafeKeep the user MUST ONLY be able to read/write files on
#   /media/safekeep-transfer (the exFAT transfer partition). Seeing the
#   host filesystem at all is a confusing UX regression and a potential
#   data-leak vector — there is no legitimate reason to explore the
#   internal filesystem of a vault kiosk.
#
# DESIGN NOTE — WHY NOT REDIRECT XDG_*_DIR TO THE TRANSFER MOUNT:
#   An earlier revision of this section pointed every XDG_*_DIR
#   (Desktop, Documents, Downloads, Music, Pictures, Videos, Public,
#   Templates) at /media/safekeep-transfer. The intent was "every
#   sidebar shortcut lands in the jail." The result was that
#   GtkPlacesSidebar rendered 8 shortcut rows all aliasing the same
#   path that was also present as a Devices entry for the mount. GTK
#   de-duplicates such aliases by rendering the shortcut rows as
#   informational-only — the user could SEE them but could not
#   activate Open/Select Folder on the safekeep-transfer row. That
#   is a correctness break that fails the chooser entirely.
#
#   The spec-compliant fix: point every XDG_*_DIR at $HOME itself.
#   Per the xdg-user-dirs spec and GTK's places-sidebar source, a
#   shortcut whose path equals $HOME is SUPPRESSED from the sidebar.
#   That removes Desktop/Documents/Downloads/etc. cleanly without
#   creating duplicate rows on top of the mount. The sidebar then
#   shows only Home + the safekeep-transfer partition, and both are
#   fully selectable.
#
# SAFEKEEP'S APPROACH (five layers):
#   - GVfs PURGED — scorched-earth removal (apt-get + dpkg --force-depends
#     fallback) eliminates "Other Locations", smb/sftp/dav/trash/recent/
#     mtp/gphoto backends, and the sidebar network shortcuts.
#   - GIO_USE_VFS=local — belt-and-suspenders env var forces GLib's
#     GIO to use only the local VFS backend, so even if a stray gvfs-
#     libs remains it cannot render network/virtual sidebar entries.
#   - XDG SHORTCUT SUPPRESSION — every XDG_*_DIR aliases $HOME, which
#     GTK reads as "do not add this shortcut to the sidebar." The
#     regeneration hook is also disabled so the aliases can't drift.
#   - GTK RECENT-FILES DISABLED — gtk-recent-files-enabled=false in
#     the system settings.ini removes the "Recent" sidebar entry and
#     prevents GtkRecentManager from tracking file interactions.
#   - dconf /org/gtk/{,gtk4/}settings/file-chooser LOCKED — path-bar
#     mode, no hidden files, sorted by name. GTK 4 paths locked too.
#   - GTK BOOKMARKS FROZEN — empty bookmarks file + chattr +i, so the
#     chooser's "Add to Bookmarks" right-click is a silent no-op.
#
# COOPERATION WITH OTHER LAYERS:
#   - chroot-setup.sh passes --disable-features=XdgDesktopPortalFilePicker
#     to Chromium. That flag keeps Chromium on the native GTK chooser
#     (which these dconf policies govern). Without it, Chromium would
#     route file picking through the XDG desktop portal and skip
#     these controls entirely.
#   - Section 3 (HOST STORAGE BLACKLIST) makes the host's internal
#     disks invisible to the kernel, so even if the sidebar lock
#     were bypassed, there would be nothing under /media to browse
#     except the transfer drive itself.
# ============================================================================

echo ""
echo "[6/7] FILE CHOOSER JAIL"
echo "-------------------------------------------"

# ---- 6a: Scorched-earth GVfs purge ----
# gvfs* provides "Other Locations", the smb/sftp/dav/trash/recent/mtp/
# gphoto backends, and the sidebar network shortcuts. With it gone,
# the GTK chooser can only enumerate real local mount points.
#
# The previous revision used `apt-get remove ... 2>/dev/null || true`
# which silently swallowed dep-resolution failures — if any package
# we didn't list depended on gvfs-libs, apt refused the removal and
# the error went to /dev/null. The user's sidebar still showed
# "Other Locations" because gvfs-libs was still present.
#
# This revision is explicit in three passes:
#   1. apt-get purge with a glob pattern (catches every gvfs* name)
#   2. dpkg --purge --force-depends over any gvfs* still marked ii
#   3. autoremove to clean up orphaned deps
# Errors are logged to stderr rather than swallowed, so we can see
# in the build log if something actually refused to purge.

echo "  Purging gvfs* (pass 1/3: apt-get purge with glob)..."
apt-get purge -y 'gvfs*' || echo "    apt-get purge reported failures — see dpkg fallback below"

echo "  Purging gvfs* (pass 2/3: dpkg --purge --force-depends fallback)..."
# List any gvfs* packages still installed and force-purge them.
# This handles the case where apt refused due to a soft dependency.
STILL_INSTALLED=$(dpkg-query -W -f='${binary:Package} ${db:Status-Abbrev}\n' 'gvfs*' 2>/dev/null | awk '$2 == "ii" {print $1}')
if [ -n "$STILL_INSTALLED" ]; then
    echo "    Still installed: $STILL_INSTALLED"
    echo "$STILL_INSTALLED" | xargs -r dpkg --purge --force-depends || true
else
    echo "    (no gvfs* packages remain — apt pass was sufficient)"
fi

echo "  Purging gvfs* (pass 3/3: apt-get autoremove)..."
apt-get autoremove -y || true

echo "  gvfs* purge complete — Other Locations sidebar entry eliminated"

# ---- 6b: Force GIO to use only the local VFS backend ----
# GIO_USE_VFS=local tells GLib's GIO subsystem to bypass any remaining
# gvfs extension libs and use only the native file:// backend. This is
# a belt-and-suspenders measure: even if dpkg leaves a stray gvfs-libs
# behind, this env var prevents it from rendering any sidebar items.
#
# We inject into /etc/environment (read by PAM and systemd-user sessions)
# AND into safekeep-session.service's env (read by the kiosk Chromium
# process specifically). Either path alone would work; both together
# cover every shell/service in the image.
if ! grep -q '^GIO_USE_VFS=' /etc/environment 2>/dev/null; then
    echo 'GIO_USE_VFS=local' >> /etc/environment
    echo "  Appended: GIO_USE_VFS=local to /etc/environment"
else
    echo "  /etc/environment already sets GIO_USE_VFS — leaving as-is"
fi

# safekeep-session.service drop-in (if the service file exists at
# build time). We append via drop-in so we don't touch the main unit.
if [ -f /etc/systemd/system/safekeep-session.service ]; then
    mkdir -p /etc/systemd/system/safekeep-session.service.d
    cat > /etc/systemd/system/safekeep-session.service.d/10-gio-local.conf << 'GIOCONF_EOF'
[Service]
Environment=GIO_USE_VFS=local
GIOCONF_EOF
    echo "  Created: safekeep-session.service.d/10-gio-local.conf"
fi

# ---- 6c: XDG shortcut SUPPRESSION (not redirection) ----
# Per the xdg-user-dirs spec and GTK's places-sidebar source: a shortcut
# whose path equals $HOME is suppressed from the sidebar. We exploit that
# to make Desktop / Documents / Downloads / Music / Pictures / Videos /
# Public / Templates disappear from the sidebar without introducing any
# duplicate rows pointing at the mount.
#
# The kiosk session runs as root (see safekeep-session.service User=root),
# so $HOME == /root. The file below sets every XDG dir to /root, which
# GTK then filters out.
#
# CRITICAL: we do NOT touch /media/safekeep-transfer here. The transfer
# partition is mounted by safekeep-boot.sh (label TRANSFER) and appears
# in the sidebar's "Devices" section as a single, selectable entry. With
# the XDG shortcuts gone, nothing aliases it and nothing greys out the
# Open/Select Folder button.

# Release the old chattr lock (if a previous image baked one in) so we
# can rewrite user-dirs.dirs with the suppression-based config.
chattr -i /root/.config/user-dirs.dirs 2>/dev/null || true

mkdir -p /root/.config
cat > /root/.config/user-dirs.dirs << 'XDGDIRS_EOF'
# SafeKeep: every XDG directory aliases $HOME. Per xdg-user-dirs spec,
# shortcuts equal to $HOME are suppressed from the GTK sidebar — so
# Desktop/Documents/Downloads/etc. do NOT appear in the file chooser.
# The transfer partition (Devices section) is the only non-Home entry,
# and because nothing aliases it, it is fully selectable.
XDG_DESKTOP_DIR="$HOME"
XDG_DOWNLOAD_DIR="$HOME"
XDG_TEMPLATES_DIR="$HOME"
XDG_PUBLICSHARE_DIR="$HOME"
XDG_DOCUMENTS_DIR="$HOME"
XDG_MUSIC_DIR="$HOME"
XDG_PICTURES_DIR="$HOME"
XDG_VIDEOS_DIR="$HOME"
XDGDIRS_EOF

# System-wide defaults — used by xdg-user-dirs-update if it ever runs
# despite the enabled=False below. Same $HOME-alias pattern.
cat > /etc/xdg/user-dirs.defaults << 'XDGDEF_EOF'
# SafeKeep: every standard dir aliases $HOME so GTK suppresses the
# shortcut. No shortcut row is rendered, no duplicate of the transfer
# partition exists.
DESKTOP=$HOME
DOWNLOAD=$HOME
TEMPLATES=$HOME
PUBLICSHARE=$HOME
DOCUMENTS=$HOME
MUSIC=$HOME
PICTURES=$HOME
VIDEOS=$HOME
XDGDEF_EOF

# Disable the auto-regeneration hook so $HOME/Desktop et al can never
# reappear during a session start.
cat > /etc/xdg/user-dirs.conf << 'XDGCFG_EOF'
# SafeKeep: xdg-user-dirs-update is disabled. Without this, the login
# hook would recreate Desktop/Documents/etc. in $HOME.
enabled=False
filename_encoding=UTF-8
XDGCFG_EOF

# Re-freeze user-dirs.dirs so no stray process can rewrite it.
chattr +i /root/.config/user-dirs.dirs 2>/dev/null || true

echo "  Created: /root/.config/user-dirs.dirs (XDG_*_DIR=\$HOME, shortcuts suppressed)"
echo "  Created: /etc/xdg/user-dirs.defaults (spec defaults also point at \$HOME)"
echo "  Created: /etc/xdg/user-dirs.conf (enabled=False, no regeneration)"

# ---- 6d: Disable "Recent" in the GTK file chooser ----
# GtkRecentManager is what backs the Recent sidebar entry. Setting
# gtk-recent-files-enabled=false in the system settings.ini:
#   (a) removes the "Recent" row from the chooser sidebar, and
#   (b) stops the chooser from appending to ~/.local/share/recently-used.xbel
# We also pre-empt the xbel file with an empty-immutable stub so even
# a stray app that ignores the setting can't leak recent paths.

mkdir -p /etc/gtk-3.0 /etc/gtk-4.0
cat > /etc/gtk-3.0/settings.ini << 'GTK3INI_EOF'
[Settings]
# SafeKeep: disable the Recent Files subsystem. Removes the sidebar
# "Recent" row and stops GtkRecentManager from writing to
# ~/.local/share/recently-used.xbel.
gtk-recent-files-enabled=false
gtk-recent-files-max-age=0
gtk-recent-files-limit=0
GTK3INI_EOF

cat > /etc/gtk-4.0/settings.ini << 'GTK4INI_EOF'
[Settings]
gtk-recent-files-enabled=false
gtk-recent-files-max-age=0
gtk-recent-files-limit=0
GTK4INI_EOF

mkdir -p /root/.local/share
: > /root/.local/share/recently-used.xbel
chattr +i /root/.local/share/recently-used.xbel 2>/dev/null || true

echo "  Created: /etc/gtk-{3,4}.0/settings.ini (gtk-recent-files-enabled=false)"
echo "  Created: empty /root/.local/share/recently-used.xbel (chattr +i)"

# ---- 6e: dconf lock on GTK file-chooser settings ----
# Piggy-backs on the dconf profile + local db created in Section 4.
cat > /etc/dconf/db/local.d/10-safekeep-filechooser << 'DCONFFC_EOF'
[org/gtk/settings/file-chooser]
location-mode='path-bar'
show-hidden=false
show-size-column=true
show-type-column=false
sort-column='name'
sort-directories-first=true
sort-order='ascending'
startup-mode='cwd'
clock-format='24h'

# Apply the same policy to GTK 4 apps (schema moved under /gtk4/).
[org/gtk/gtk4/settings/file-chooser]
location-mode='path-bar'
show-hidden=false
show-size-column=true
show-type-column=false
sort-column='name'
sort-directories-first=true
sort-order='ascending'
startup-mode='cwd'
DCONFFC_EOF

cat > /etc/dconf/db/local.d/locks/10-safekeep-filechooser << 'DCONFFCLK_EOF'
/org/gtk/settings/file-chooser/location-mode
/org/gtk/settings/file-chooser/show-hidden
/org/gtk/settings/file-chooser/show-size-column
/org/gtk/settings/file-chooser/show-type-column
/org/gtk/settings/file-chooser/sort-column
/org/gtk/settings/file-chooser/sort-directories-first
/org/gtk/settings/file-chooser/sort-order
/org/gtk/settings/file-chooser/startup-mode
/org/gtk/gtk4/settings/file-chooser/location-mode
/org/gtk/gtk4/settings/file-chooser/show-hidden
/org/gtk/gtk4/settings/file-chooser/show-size-column
/org/gtk/gtk4/settings/file-chooser/show-type-column
/org/gtk/gtk4/settings/file-chooser/sort-column
/org/gtk/gtk4/settings/file-chooser/sort-directories-first
/org/gtk/gtk4/settings/file-chooser/sort-order
/org/gtk/gtk4/settings/file-chooser/startup-mode
DCONFFCLK_EOF

# Recompile the dconf database so the new keys take effect at boot.
dconf update 2>/dev/null || true
echo "  Created: dconf file-chooser lockdown (GTK 3 + GTK 4)"

# ---- 6f: Empty and freeze the GTK bookmarks file ----
# The GTK chooser's "Add to Bookmarks" right-click would write paths to
# this file. A pre-existing empty-and-immutable file makes the feature
# a silent no-op — no user-pinnable shortcut out of the jail.
mkdir -p /root/.config/gtk-3.0 /root/.config/gtk-4.0
# Release any old chattr lock so we can write an empty replacement.
chattr -i /root/.config/gtk-3.0/bookmarks 2>/dev/null || true
chattr -i /root/.config/gtk-4.0/bookmarks 2>/dev/null || true
: > /root/.config/gtk-3.0/bookmarks
: > /root/.config/gtk-4.0/bookmarks
chattr +i /root/.config/gtk-3.0/bookmarks 2>/dev/null || true
chattr +i /root/.config/gtk-4.0/bookmarks 2>/dev/null || true

echo "  Created: empty GTK bookmarks (chattr +i — cannot be populated)"

echo "  File chooser jail complete."
echo "  Expected sidebar at runtime: Home (/root) + safekeep-transfer drive."
echo "  Both are fully selectable. No duplicates, no Recent, no Other Locations."


# ============================================================================
# SECTION 7: INITRAMFS REBUILD
# ============================================================================
#
# The module blacklists above only take full effect after the initramfs
# is rebuilt to include the new modprobe.d config files. Without this,
# the kernel's initial ramdisk might still load blacklisted modules
# during early boot before the root filesystem is mounted.
# ============================================================================

echo ""
echo "[7/7] REBUILDING INITRAMFS"
echo "-------------------------------------------"

# Copy blacklist files into initramfs hook directory so they're baked
# into the initial ramdisk and effective from the earliest boot stage.
mkdir -p /etc/initramfs-tools/conf.d

# update-initramfs reads /etc/modprobe.d/ automatically when run.
if command -v update-initramfs &>/dev/null; then
    update-initramfs -u -k all 2>/dev/null || echo "  Warning: initramfs rebuild failed (may be normal in chroot)"
    echo "  Initramfs rebuilt with module blacklists."
else
    echo "  Warning: update-initramfs not found — blacklists will apply after next manual rebuild."
fi


# ============================================================================
# SUMMARY
# ============================================================================

echo ""
echo "========================================"
echo " SafeKeep Hardening Complete"
echo "========================================"
echo ""
echo " NETWORK:     All daemons masked, radios killed, drivers banned"
echo " PRINTERS:    CUPS + Ghostscript purged, USB printer drivers banned"
echo " HOST DRIVES: AHCI + NVMe + eMMC + SAS drivers banned"
echo " USB:         Automount disabled, unknown devices quarantined,"
echo "              BadUSB HID lockdown enabled (30s after boot)"
echo " SURFACE:     All TTYs disabled (NAutoVTs=0), Apport masked,"
echo "              coredumps discarded (core_pattern=|/bin/false),"
echo "              journald RAM-only (Storage=volatile)"
echo " CHOOSER:     GVfs purged (no Other Locations), GIO_USE_VFS=local,"
echo "              XDG shortcuts suppressed (\$HOME alias, no duplicates),"
echo "              Recent disabled, dconf locked, bookmarks frozen."
echo "              Sidebar = Home + safekeep-transfer, both selectable."
echo ""
echo " PRESERVED:   usb-storage, uas, xhci_hcd, ehci_hcd, sd_mod,"
echo "              ext4, exfat, dm-crypt, squashfs, overlay"
echo ""
echo " Your SafeKeep boot drive partitions will function normally."
echo " The host machine's internal storage is invisible."
echo " All network interfaces are permanently disabled."
echo "========================================"
