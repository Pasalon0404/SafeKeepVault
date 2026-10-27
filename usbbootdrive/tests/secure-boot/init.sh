#!/bin/sh
# Test initramfs: report how the kernel was started, then power off.
mount -t proc proc /proc; mount -t sysfs sys /sys; mount -t devtmpfs dev /dev
mount -t securityfs s /sys/kernel/security 2>/dev/null
mount -t efivarfs e /sys/firmware/efi/efivars 2>/dev/null
echo "SKTEST cmdline: $(cat /proc/cmdline)"
if [ -d /sys/firmware/efi ]; then
  sb=$(hexdump -v -e '/1 "%d "' /sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c 2>/dev/null | awk '{print $NF}')
  echo "SKTEST firmware: UEFI, SecureBoot=$sb"
else
  echo "SKTEST firmware: legacy BIOS"
fi
echo "SKTEST lockdown: $(cat /sys/kernel/security/lockdown 2>/dev/null)"
dmesg | grep -i -E "secure ?boot|lockdown" | sed 's/^/SKTEST dmesg: /'
try() {
  n0=$(dmesg | wc -l)
  echo "SKTEST $1: $(/bin/kmod-load "$2")"
  dmesg | tail -n +$((n0+1)) | grep -v "^$" | sed "s/^/SKTEST   kernel: /"
  rmmod exfat 2>/dev/null
}
try "unsigned exfat module" /m/exfat-unsigned.ko
try "signed exfat module" /m/exfat.ko
echo "SKTEST done"
poweroff -f
