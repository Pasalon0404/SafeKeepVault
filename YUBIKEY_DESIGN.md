# Design note: unlocking the vault with a YubiKey

Status: **design, waiting for the owner's approval** (Nov 14, 2026). Nothing
is built yet. Not for a release until the owner says so (`CLAUDE.md`).

## The idea

Today the vault opens with the Master Passphrase only, typed or scanned
from its QR code. This adds a choice, **How this vault unlocks**, in
Device Options:

| Choice | What opens the vault |
|---|---|
| **Master Passphrase** (the default, as today) | the passphrase, typed or scanned |
| **Passphrase or YubiKey** | either one |
| **YubiKey only** | a YubiKey, its PIN and a touch |
| **Passphrase and YubiKey** | the passphrase and a YubiKey together |

Nothing changes for anyone who doesn't choose it. First setup still asks for
a Master Passphrase only, the unlock screen shows **Use YubiKey** only on a
vault that has one, and every existing flash drive stays on Master
Passphrase after the update.

### Why each choice is there

- **Passphrase or YubiKey** — quicker than typing, and safer than keeping
  the QR card next to the flash drive: a photo of a QR card copies it, a
  YubiKey can't be copied, it needs its PIN, and it locks itself after 8
  wrong PINs. It doesn't make the vault stronger, since the passphrase
  still opens it.
- **YubiKey only** — for people who struggle with long passphrases. It is
  stronger than it sounds. With a passphrase, someone who copies the flash
  drive can guess passphrases on their own computers for as long as they
  like. With YubiKey only, the vault's key comes from a secret that never
  leaves the YubiKey, so the flash drive alone gives them nothing to guess,
  and the YubiKey allows 8 PIN guesses in total.
- **Passphrase and YubiKey** — the strongest: a stolen flash drive and a
  known passphrase are not enough, and neither is a stolen YubiKey and
  its PIN.

The risk in the last two is losing the YubiKey. The safeguards below are
there for that.

## Facts the design rests on

- **The vault is LUKS2** with Argon2id (`setup-vault.sh`, cryptsetup
  defaults; see `PASSPHRASE_STRENGTH_DESIGN.md`), in the file `.vault.luks`
  on the data partition, opened through a loop device by `unlock-vault.sh`.
  LUKS2 has up to 32 key slots, any one of which opens the vault, and
  *tokens*: small JSON records in the header that anyone can read, with no
  key needed (`cryptsetup luksDump --dump-json-metadata`,
  `cryptsetup token import`).
- **FIDO2 `hmac-secret`.** A YubiKey 5 or a Yubico Security Key (FIDO2
  models; not the older U2F-only keys or YubiKey 4) can make a credential
  for SafeKeep and, given that credential's ID and a 32-byte *salt*, return
  32 secret bytes. The bytes depend on a secret inside the YubiKey that
  never leaves it, so the same YubiKey, credential and salt always give the
  same bytes, and nothing else can. With "user verification" required, the
  YubiKey answers only after its FIDO2 PIN, and with "user presence", only
  after a touch.
- **Nothing is stored on the YubiKey.** The credential is *non-resident*:
  its ID (which the YubiKey can decode, and no one else can use) lives in
  the vault's header. So a YubiKey can serve any number of vaults, and
  erasing a vault leaves nothing on the YubiKey to clean up.
- **The PIN.** FIDO2 PINs are at least 4 characters (SafeKeep will ask for
  6 or more). After 3 wrong PINs in a row the YubiKey must be unplugged and
  plugged back in; after 8 wrong PINs in total its FIDO2 part is blocked.
  The only way out of that is a FIDO2 reset, which changes its secret, so
  that YubiKey can never open this vault again.
- **The existing Change Master Passphrase flow** (`change-passphrase.sh`)
  locks the vault, closes Chromium, and runs native dialogs before the
  unlock prompt, so secrets never pass through the browser. YubiKey
  management uses the same approach.
- **The Encrypted Backup (`.7z`) has its own password**, set on the backup
  screen. This design doesn't touch it.

## How it works

### The key for each slot

Each YubiKey that is added gets its own credential, salt and key slot. The
slot's key is:

- **Passphrase or YubiKey / YubiKey only:** the 32 bytes the YubiKey
  returns, base64-encoded. LUKS's Argon2id then works on that as it does on
  a passphrase.
- **Passphrase and YubiKey:** HMAC-SHA256, keyed with the YubiKey's 32
  bytes, of the passphrase (normalized the same way as today). Neither
  half alone opens the slot.

A **token** next to each slot records, in plain sight: the type
(`safekeep-yubikey`), the key slot, the credential ID, the salt, the
YubiKey's name ("YubiKey 1", "Spare", renamable) and the date it was added.
One more token records the vault's choice (`passphrase`, `either`,
`yubikey`, `both`). The header therefore shows that a vault uses a
YubiKey, and which choice it has. That reveals nothing that helps open it.

### Which key slots exist in each choice

| Choice | Passphrase slot | YubiKey slots |
|---|---|---|
| Master Passphrase | yes | none |
| Passphrase or YubiKey | yes | YubiKey's bytes, one per YubiKey |
| YubiKey only | **none** | YubiKey's bytes, one per YubiKey |
| Passphrase and YubiKey | **none** | passphrase + YubiKey's bytes, one per YubiKey |

### The code

- **`safekeep-yubikey.py`** (new, in the image): the only code that talks to
  a YubiKey. It uses Yubico's own Python library, `python-fido2`, from
  Ubuntu's archive (`python3-fido2`),
  over the kernel's `hidraw`. Ubuntu 24.04 has version 1.1.2. Actions: `list` (YubiKeys plugged in),
  `set-pin`, `enroll` (makes a credential, returns the slot key and the
  token), and `unlock-key` (returns a slot key for a token). Like
  `safekeep-passphrase.py`, secrets go through pipes, never on the command
  line or to disk, and nothing is logged.
- **`unlock-vault.sh`** reads the choice from the header and offers only
  what this vault takes: **Use YubiKey** alongside Scan QR Code and typing
  (Passphrase or YubiKey), YubiKey alone (YubiKey only), or the passphrase
  followed by the YubiKey (Passphrase and YubiKey). Then: "Plug in your
  YubiKey" → type its PIN → "Touch your YubiKey". It tries each YubiKey
  token for the YubiKey that is plugged in, and opens the vault with
  `cryptsetup open --key-slot`.
- **`manage-yubikey.sh`** (new, like `change-passphrase.sh`): the app asks
  for it with a power action, `safekeep-boot.sh` locks the vault, and the
  native dialogs run before the unlock prompt.
- **The app** never sees a PIN, a passphrase or a slot key. After unlocking,
  `unlock-vault.sh` leaves only a summary in RAM (the choice, and each
  YubiKey's name and date) for Device Options to show.

### Device Options → Master Passphrase

Shows **How this vault unlocks** and the YubiKeys added, with:

- **Add a YubiKey** — confirm the vault (with whatever opens it now), plug
  in the YubiKey, set its PIN if it has none (or type it), touch it, name
  it. The new slot is tested before the flow ends. At most 4 YubiKeys.
- **Remove** a YubiKey — refused if it would leave no way in (see below).
- **Change how this vault unlocks** — moves between the four choices.
- **Change Master Passphrase** — as today. In YubiKey only, it's hidden
  and **Add a Master Passphrase** takes its place. In Passphrase and
  YubiKey, every YubiKey has to be plugged in, one after the other, because
  each slot mixes the passphrase with that YubiKey.

## Safeguards

1. **A spare YubiKey is recommended, not required** (the owner's decision,
   Nov 14). One YubiKey is enough to move to YubiKey only, or Passphrase
   and YubiKey. Before the move, each YubiKey has to open the vault once in
   that flow, so a mistyped PIN or a faulty key is caught while the old way
   still works. With only one YubiKey, the warning in 3 says so plainly,
   and Device Options suggests adding a spare to keep somewhere else.
2. **Never leave the vault without a way in.** Every change adds and tests
   the new key slots first, and only then removes the old ones. Before any
   change, the header is copied to RAM (`cryptsetup luksHeaderBackup`) and
   put back if anything fails, and the flow ends with the old way still
   working. Removing the last YubiKey of a vault with no passphrase is
   refused.
3. **Plain warnings at the right moments:**
   - when setting a PIN: "After 8 wrong PINs this YubiKey is locked for
     good, and can't open this vault again";
   - before YubiKey only or Passphrase and YubiKey: "If you lose your
     YubiKey (or every YubiKey you add), or forget the passphrase with
     Passphrase and YubiKey, this vault can't be opened. Your seed backup still restores your wallet.
     Saved wallets, the Passphrase Library and notes come back only from an
     Encrypted Backup." with a link to make one now. With one YubiKey it
     adds: "Only one YubiKey can open this vault. A spare kept somewhere
     else protects you if it's lost or broken." The move goes ahead only
     after checking a box that says you understand.
4. **The weak-passphrase checks stay where a passphrase is used.**
   Passphrase or YubiKey and Passphrase and YubiKey keep today's strength
   check. YubiKey only has no passphrase, so the Dashboard's passphrase
   warning and the Master Passphrase rating are replaced by "This vault
   unlocks with a YubiKey (1 added)".
5. **Factory reset** is unchanged: destroying the header removes every key
   slot and token, YubiKey ones included.
6. **A Temporary Session** never opens the vault, so it is unaffected.
7. **Restoring an Encrypted Backup onto a new flash drive** sets up a new
   vault with a passphrase, as today. YubiKeys are added again there, since
   each credential belongs to one vault.

## USB: letting a YubiKey in safely

About 30 seconds after boot, `85-safekeep-hid-lockdown.rules` turns off any
new USB keyboard-type (HID) device, and a YubiKey is one. A YubiKey has up
to three parts: **OTP**, which acts as a keyboard and types codes;
**FIDO2**, which is HID but not a keyboard; and **smart card**, which is
not HID.

The Coldcard's exception tells the kernel's HID driver to ignore the
device completely, so even a device faking its ID can never type. That
doesn't fit here:
- the kernel takes at most 4 such entries (`usbhid.quirks`), and the
  Coldcard uses one, while Yubico has more product IDs than the 3 left;
- ignoring the device would also remove the `hidraw` access that FIDO2
  needs.

Instead, for Yubico's vendor ID (`1050`) only:
- **The FIDO2 part is let through.**
- **The OTP part is turned off.** That's the interface that says it's a
  boot keyboard.
- **Any input device that appears under a Yubico ID is *inhibited* at
  once** (`/sys/class/input/*/inhibited`), so even a fake "YubiKey" whose
  FIDO2-looking part secretly describes a keyboard can't type.

This is as strong as the lockdown is today: the existing rule also acts as
the device appears. A YubiKey plugged in before boot (and so before the
lockdown) is treated the same way by the inhibit rule, so its OTP part
never types in SafeKeep either. SafeKeep doesn't set the kernel's SysRq
keys today (Ubuntu leaves some of them on). Part 1 turns them off
(`kernel.sysrq = 0`), so no keyboard can reach the kernel's own key
handling. That helps the existing lockdown too.

`test-os-lockdown.mjs` gets cases for the new rules.

## Building it

**Part 1 — YubiKey support, "Passphrase or YubiKey" and "YubiKey only"**
- `python3-fido2` in the image (`chroot-setup.sh`, with an import check
  like the Trezor library's); the udev rules above.
- `safekeep-yubikey.py`, `manage-yubikey.sh`, the YubiKey screens in
  `unlock-vault.sh`, and the Device Options section in `boot.html`.
- Safeguards 1–7.
- Tests:
  - a fake FIDO2 YubiKey for the helper (like the fake Trezor in
    `test-trezor-helper.py`), covering PIN, touch, wrong PINs and a
    blocked PIN;
  - real `cryptsetup` on a small vault file for every change between
    choices, including failures halfway (like `test-change-passphrase.mjs`);
  - the USB rules; the Device Options panel.

**Part 2 — "Passphrase and YubiKey"**
- The combined key slot, Change Master Passphrase with each YubiKey, and
  its unlock screen. A separate part because combining two secrets into
  one key needs its own review.

Both parts add OS files, so the release that carries them needs the full
build. They can ship in one release or two.

**Testing on real hardware (the owner):**
- A YubiKey 5 or Security Key with FIDO2. A second one helps test adding
  and removing a spare, but isn't needed.
- Run through each change between choices on a test flash drive, not the
  everyday one.
- Plug the YubiKey in before boot and after the 30-second lockdown, both
  directly and through a hub.

## Questions for the owner

1. **Names:** "How this vault unlocks", and the four choices as written
   above?
2. **YubiKey only on a new flash drive:** should first setup also offer it?
   This design says no: setup stays passphrase-only, and the YubiKey is
   added afterwards in Device Options. That keeps setup unchanged for the
   many people with no YubiKey.
3. **Other FIDO2 keys** (SoloKeys, Nitrokey, Google Titan) work the same
   way in principle. The USB exception above names Yubico only. Should it
   stay Yubico-only for now?
