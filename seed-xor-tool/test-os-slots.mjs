/**
 * test-os-slots.mjs — the two OS slots on the stick (UPDATER_DESIGN.md).
 *   1. os-slots.sh on a temporary folder standing in for the OS partition:
 *      layout detection, which slot boots (with the same fallback as GRUB),
 *      writing a slot (checked, never touching the other slot or slot.cfg),
 *      switching, refusing an incomplete OS, and a leftover from a power cut.
 *   2. grub.cfg: boots slot.cfg's slot via live-media-path, falls back to the
 *      other slot, offers "previous version"; passes grub-script-check when
 *      it is installed.
 *   3. build.sh: sizes fit an 8 GB stick and two copies of the OS, the OS goes
 *      into casper-a/ with slot.cfg, GRUB gets the test/configfile modules,
 *      and the maintainer key is pinned and identical to developer-pubkey.asc.
 *   4. quick-update.sh writes the idle slot and switches on two-slot sticks.
 * Needs bash. Run: node test-os-slots.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OS = join(ROOT, 'usbbootdrive');
let pass = 0, fail = 0;
const ck = (n, c, x) => { c ? pass++ : fail++; if (!c || process.env.V) console.log((c ? '  PASS ' : '  FAIL ') + n + (c || x === undefined ? '' : '  -> ' + x)); };
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Run one os-slots.sh function in bash; returns { code, out, err }.
const slots = (cmd) => {
  const r = spawnSync('bash', ['-c', `source "${join(OS, 'os-slots.sh')}"; ${cmd}`], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const makeOs = (dir, tag) => {
  mkdirSync(dir, { recursive: true });
  for (const f of ['filesystem.squashfs', 'vmlinuz', 'initrd', 'filesystem.size', 'filesystem.manifest'])
    writeFileSync(join(dir, f), `${tag}:${f}\n`);
};

// ---- 1. os-slots.sh ----
console.log('1. os-slots.sh');
{
  const t = mkdtempSync(join(tmpdir(), 'sk-slots-'));
  const mnt = join(t, 'os');
  const v1 = join(t, 'v1'), v2 = join(t, 'v2'), v3 = join(t, 'v3');
  makeOs(v1, 'v1'); makeOs(v2, 'v2'); makeOs(v3, 'v3');

  mkdirSync(mnt);
  ck('empty partition: layout unknown', slots(`slot_layout "${mnt}"`).out === 'unknown');
  mkdirSync(join(mnt, 'casper'));
  ck('casper/ only: layout legacy', slots(`slot_layout "${mnt}"`).out === 'legacy');
  rmSync(join(mnt, 'casper'), { recursive: true });

  // A fresh build: slot A plus slot.cfg.
  let r = slots(`slot_write "${mnt}" a "${v1}" && slot_switch "${mnt}" a`);
  ck('write + switch slot a', r.code === 0, r.err);
  ck('layout two-slot', slots(`slot_layout "${mnt}"`).out === 'two-slot');
  ck('slot.cfg says a', readFileSync(join(mnt, 'slot.cfg'), 'utf8') === 'set slot=a\n');
  ck('active slot a', slots(`slot_active "${mnt}"`).out === 'a');
  ck('slot a holds v1, manifest included', readFileSync(join(mnt, 'casper-a', 'vmlinuz'), 'utf8') === 'v1:vmlinuz\n' && existsSync(join(mnt, 'casper-a', 'filesystem.manifest')));
  ck('no temporary folder left', !existsSync(join(mnt, '.casper-a.new')));

  // An update: v2 into the idle slot, then switch.
  r = slots(`a=$(slot_active "${mnt}"); i=$(slot_other $a); slot_write "${mnt}" $i "${v2}" && echo $i`);
  ck('update writes the idle slot b', r.code === 0 && r.out === 'b', r.err);
  ck('slot.cfg unchanged until switch', readFileSync(join(mnt, 'slot.cfg'), 'utf8') === 'set slot=a\n');
  ck('slot a untouched', readFileSync(join(mnt, 'casper-a', 'vmlinuz'), 'utf8') === 'v1:vmlinuz\n');
  r = slots(`slot_switch "${mnt}" b`);
  ck('switch to b', r.code === 0 && slots(`slot_active "${mnt}"`).out === 'b', r.err);
  ck('no temporary slot.cfg left', !existsSync(join(mnt, '.slot.cfg.new')));

  // Next update goes back into slot a and replaces v1.
  r = slots(`slot_write "${mnt}" a "${v3}"`);
  ck('next update rewrites slot a', r.code === 0 && readFileSync(join(mnt, 'casper-a', 'initrd'), 'utf8') === 'v3:initrd\n', r.err);
  ck('...while slot b still boots', slots(`slot_active "${mnt}"`).out === 'b');

  // GRUB-style fallback: slot.cfg names a slot with no kernel.
  rmSync(join(mnt, 'casper-a', 'vmlinuz'));
  writeFileSync(join(mnt, 'slot.cfg'), 'set slot=a\n');
  ck('slot.cfg names a slot without a kernel: falls back to b', slots(`slot_active "${mnt}"`).out === 'b');
  ck('switching to an incomplete slot is refused', slots(`slot_switch "${mnt}" a`).code !== 0);
  ck('...and slot.cfg is unchanged', readFileSync(join(mnt, 'slot.cfg'), 'utf8') === 'set slot=a\n');
  writeFileSync(join(mnt, 'slot.cfg'), 'garbage\n');
  ck('unreadable slot.cfg: treated as a (then fallback to b)', slots(`slot_active "${mnt}"`).out === 'b');

  // Incomplete source OS.
  const bad = join(t, 'bad'); makeOs(bad, 'bad'); rmSync(join(bad, 'initrd'));
  r = slots(`slot_write "${mnt}" a "${bad}"`);
  ck('an OS without initrd is refused before writing', r.code !== 0 && /initrd/.test(r.err) && existsSync(join(mnt, 'casper-a', 'initrd')), r.err);
  ck('bad slot name refused', slots(`slot_write "${mnt}" c "${v1}"`).code !== 0 && slots(`slot_switch "${mnt}" ../x`).code !== 0);

  // Leftover from a power cut mid-write.
  mkdirSync(join(mnt, '.casper-a.new'));
  writeFileSync(join(mnt, '.casper-a.new', 'filesystem.squashfs'), 'half');
  r = slots(`slot_write "${mnt}" a "${v1}" && slot_switch "${mnt}" a`);
  ck('a half-written leftover is replaced', r.code === 0 && !existsSync(join(mnt, '.casper-a.new')) && readFileSync(join(mnt, 'casper-a', 'filesystem.squashfs'), 'utf8') === 'v1:filesystem.squashfs\n', r.err);
  ck('both slots complete at the end', ['casper-a', 'casper-b'].every((s) => readdirSync(join(mnt, s)).includes('vmlinuz')));
  rmSync(t, { recursive: true, force: true });
}

// ---- 2. grub.cfg ----
console.log('2. grub.cfg');
{
  const g = read('usbbootdrive/grub.cfg');
  ck('finds the OS partition by label', g.includes('search --no-floppy --label --set=ospart safekeep-os'));
  ck('reads slot.cfg', /if \[ -f \/slot\.cfg \]; then\s+source \/slot\.cfg/.test(g));
  ck('falls back when the slot has no kernel', g.includes('if [ ! -f /casper-${slot}/vmlinuz ]; then'));
  ck('boots the slot with live-media-path', g.includes('linux /casper-${slot}/vmlinuz boot=casper live-media-path=casper-${slot}'));
  ck('initrd from the same slot', (g.match(/initrd \/casper-\$\{slot\}\/initrd/g) || []).length === 2);
  ck('"previous version" only when the other slot has a kernel', /if \[ -f \/casper-\$\{other\}\/vmlinuz \]; then\s+menuentry "SafeKeepVault \(previous version/.test(g));
  ck('keeps the boot options of the old config', (g.match(/nopersistent noprompt/g) || []).length === 3 && g.includes('usbhid.quirks=0xd13e:0xcc10:0x4'));
  const chk = spawnSync('grub-script-check', [join(OS, 'grub.cfg')], { encoding: 'utf8' });
  if (chk.error) console.log('  (grub-script-check not installed: syntax check skipped)');
  else ck('grub-script-check accepts it', chk.status === 0, chk.stderr);
}

// ---- 3. build.sh ----
console.log('3. build.sh');
{
  const b = read('usbbootdrive/build.sh');
  const num = (name) => Number((b.match(new RegExp(`^${name}=(\\d+)`, 'm')) || [])[1]);
  const efi = num('EFI_SIZE_MB'), os = num('OS_SIZE_MB'), data = num('DATA_SIZE_MB'), tr = num('TRANSFER_SIZE_MB');
  const total = 1 + 2 + efi + os + data + tr + 1;
  ck('TOTAL_SIZE_MB is computed from the partitions', b.includes('TOTAL_SIZE_MB=$(( 1 + 2 + EFI_SIZE_MB + OS_SIZE_MB + DATA_SIZE_MB + TRANSFER_SIZE_MB + 1 ))'));
  ck(`image (${total} MB) fits a real 8 GB stick (7,400 MB)`, total <= 7400);
  ck(`OS partition (${os} MB) holds two 1,600 MB slots`, os >= 2 * 1600 + 160);
  ck(`Transfer Drive (${tr} MB) holds a 1,600 MB update file`, tr >= 1600 + 512);
  ck('build refuses if two OS copies do not fit', b.includes('if [ $(( OS_CONTENT_SIZE * 2 + 160 )) -gt "$OS_SIZE_MB" ]; then'));
  ck('OS goes into casper-a/', b.includes('cp "$STAGING_DIR/casper/vmlinuz" "$WORKSPACE/mnt-os/casper-a/"') && !b.includes('mnt-os/casper/"'));
  ck('slot.cfg written', b.includes(`printf 'set slot=a\\n' > "$WORKSPACE/mnt-os/slot.cfg"`));
  ck('grub.cfg used for BIOS and UEFI', b.includes('cp grub.cfg "$WORKSPACE/mnt-efi/boot/grub/grub.cfg"') && b.includes('"boot/grub/grub.cfg=$WORKSPACE/mnt-efi/boot/grub/grub.cfg"'));
  ck('GRUB gets test + configfile (UEFI and BIOS)', (b.match(/gzio test configfile"/g) || []).length === 2);
  ck('missing grub.cfg / key stops the build early', b.indexOf('for f in grub.cfg "$MAINTAINER_KEY"; do') > 0 && b.indexOf('for f in grub.cfg "$MAINTAINER_KEY"; do') < b.indexOf('echo "Phase 2:'));
  const fpr = (read('VERIFYING.md').match(/A333 EB82[0-9A-F ]+/) || [''])[0].replace(/\s+/g, '');
  ck('pinned fingerprint matches VERIFYING.md', b.includes(`MAINTAINER_FPR="${fpr}"`) && fpr.length === 40);
  ck('image key identical to developer-pubkey.asc', read('usbbootdrive/config/maintainer-pubkey.asc') === read('developer-pubkey.asc'));
  ck('key installed as a gpgv keyring, gpgv checked', b.includes('--dearmor -o "$CHROOT_DIR/usr/local/share/safekeep/maintainer.gpg"') && b.includes('chroot "$CHROOT_DIR" gpgv --version'));
}

// ---- 4. quick-update.sh ----
console.log('4. quick-update.sh');
{
  const q = read('usbbootdrive/quick-update.sh');
  ck('sources os-slots.sh', q.includes('source "$(dirname "$0")/os-slots.sh"'));
  ck('two-slot: writes the idle slot, then switches', /slot_write "\$MNT" "\$IDLE" "\$STAGING_DIR\/casper" \|\| die[\s\S]*slot_switch "\$MNT" "\$IDLE" \|\| die/.test(q));
  ck('older sticks still updated in casper/', q.includes('cp "$STAGING_DIR/casper/$f" "$MNT/casper/.$f.new"'));
  ck('unknown layout refused', q.includes('die "no casper-a/ or casper/ folder'));
  const syn = spawnSync('bash', ['-n', join(OS, 'quick-update.sh')]);
  ck('bash -n quick-update.sh', syn.status === 0);
  ck('bash -n build.sh', spawnSync('bash', ['-n', join(OS, 'build.sh')]).status === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
