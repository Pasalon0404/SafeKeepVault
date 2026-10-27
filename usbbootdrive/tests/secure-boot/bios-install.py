# Install GRUB for legacy BIOS on a GPT disk image, as grub-bios-setup does:
# boot.img into the MBR's code area (partition table kept) pointing at
# core.img, and core.img into the BIOS Boot partition with its block list
# pointing at the rest of itself.
import sys, struct
img, core_lba = sys.argv[1], int(sys.argv[2])
boot = open('/usr/lib/grub/i386-pc/boot.img', 'rb').read()
core = bytearray(open('/tmp/sk-core.img', 'rb').read())
core += b'\0' * (-len(core) % 512)
nsec = len(core) // 512
with open(img, 'r+b') as f:
    mbr = bytearray(f.read(512))
    mbr[0:0x1b8] = boot[0:0x1b8]                       # code only; keep disk signature + partition table
    struct.pack_into('<Q', mbr, 0x5c, core_lba)          # GRUB_BOOT_MACHINE_KERNEL_SECTOR
    mbr[0x64] = 0xff                                      # boot drive: use the BIOS drive number
    f.seek(0); f.write(mbr)
    # diskboot.img (first sector of core.img): block list at the end of the sector
    struct.pack_into('<QHH', core, 0x200 - 12, core_lba + 1, nsec - 1, 0x820)
    f.seek(core_lba * 512); f.write(core)
print(f'BIOS GRUB: boot.img in MBR, core.img ({nsec} sectors) at LBA {core_lba}')
