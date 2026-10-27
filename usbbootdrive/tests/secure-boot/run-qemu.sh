#!/bin/bash
# Boot a test image as a USB stick in QEMU and save the serial log.
#   run-qemu.sh <img> <sb-on|sb-off|bios> <log> [vars-file to use/keep] [timeout seconds]
set -u
IMG=$1; MODE=$2; LOG=$3; VARS=${4:-}; LIMIT=${5:-600}
O=/usr/share/OVMF
STICK="-device qemu-xhci -drive if=none,id=stick,file=$IMG,format=raw,snapshot=on -device usb-storage,drive=stick,bootindex=0"
case "$MODE" in
  sb-on)  [ -n "$VARS" ] || { VARS=$(mktemp); cp $O/OVMF_VARS_4M.ms.fd "$VARS"; }
          FW="-machine q35,smm=on -global driver=cfi.pflash01,property=secure,value=on
              -drive if=pflash,format=raw,unit=0,readonly=on,file=$O/OVMF_CODE_4M.secboot.fd
              -drive if=pflash,format=raw,unit=1,file=$VARS" ;;
  sb-off) [ -n "$VARS" ] || { VARS=$(mktemp); cp $O/OVMF_VARS_4M.fd "$VARS"; }
          FW="-machine q35 -drive if=pflash,format=raw,unit=0,readonly=on,file=$O/OVMF_CODE_4M.fd
              -drive if=pflash,format=raw,unit=1,file=$VARS" ;;
  bios)   FW="-machine q35" ;;
esac
timeout "$LIMIT" qemu-system-x86_64 $FW -m 1024 -smp 1 -display none -no-reboot \
    -serial file:"$LOG" $STICK >/dev/null 2>&1
echo "exit=$? log=$LOG"
