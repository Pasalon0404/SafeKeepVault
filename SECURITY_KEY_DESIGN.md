# Design note: unlocking the vault with a security key

Status: **approved** (Nov 14, 2026). **Part 1 is built** on the branch and
tested with a software FIDO2 key; not yet with a real one. Part 2 is not
built. Not for a release until the owner says so (`CLAUDE.md`).

What Part 1 does differently from the text below:
- Device Options has one **Manage Security Keys** button (Lock and
  Manage). Adding, renaming and removing keys, and changing how the vault
  unlocks, happen on the native screens that follow, not as separate
  buttons in the app.
- After adding a key, it isn't counted as tested for "Use security keys
  only": each key opens the vault once in that flow.
- Health doesn't warn about a single key; Device Options says it instead.
- The vault's choice isn't stored in a token: it's read from the key
  slots (a slot without a security key token is the passphrase's).

Owner's decisions so far (Nov 14):
- the names below;
- first setup stays passphrase-only;
- one security key is enough, and a spare is recommended, not required;
- any FIDO2 security key is accepted, not only YubiKeys.

## The idea

Today the vault opens with the Master Passphrase only, typed or scanned
from its QR code. This adds a choice, **How this vault unlocks**, in
Device Options:

| Choice | What opens the vault |
|---|---|
| **Master Passphrase** (the default, as today) | the passphrase, typed or scanned |
| **Passphrase or security key** | either one |
| **Security key only** | a security key, its PIN and a touch |
| **Passphrase and security key** | the passphrase and a security key together |

A **security key** here is any FIDO2 key with the `hmac-secret` feature,
for example:
- YubiKey 5 or Security Key by Yubico;
- Nitrokey 3, SoloKey 2 or Google Titan;
- most current keys from other makers.

The app's wording says "security key", with "(YubiKey or another FIDO2
key)" where a first-time reader needs it.

Nothing changes for anyone who doesn't choose it:
- first setup asks for a Master Passphrase only;
- the unlock screen shows **Use a security key** only on a vault that has
  one;
- every existing flash drive stays on Master Passphrase after the update.

### Why each choice is there

- **Passphrase or security key** — quicker than typing, and safer than
  keeping the QR card next to the flash drive. A photo of a QR card copies
  it. A security key can't be copied, needs its PIN, and locks itself after
  a few wrong PINs (8 on most keys). It doesn't make the vault stronger,
  since the passphrase still opens it.
- **Security key only** — for people who struggle with long passphrases. It
  is stronger than it sounds. With a passphrase, someone who copies the
  flash drive can guess passphrases on their own computers for as long as
  they like. With security key only, the vault's key comes from a secret
  that never leaves the security key. So the flash drive alone gives them
  nothing to guess, and the key allows only a few PIN guesses in total.
- **Passphrase and security key** — the strongest: a stolen flash drive and
  a known passphrase are not enough, and neither is a stolen security key
  and its PIN.

The risk in the last two is losing the security key. The safeguards below
are there for that.

## Facts the design rests on

- **The vault is LUKS2 with Argon2id** (`setup-vault.sh`, cryptsetup
  defaults; see `PASSPHRASE_STRENGTH_DESIGN.md`). It is the file
  `.vault.luks` on the data partition, opened through a loop device by
  `unlock-vault.sh`.
  - LUKS2 has up to 32 key slots, and any one of them opens the vault.
  - It also has *tokens*: small JSON records in the header that anyone can
    read without a key (`cryptsetup luksDump --dump-json-metadata`,
    `cryptsetup token import`).
- **FIDO2 `hmac-secret`.** This is a standard FIDO2 feature, the same on
  every brand that has it.
  - A key can make a credential for SafeKeep. Given that credential's ID
    and a 32-byte *salt*, it returns 32 secret bytes.
  - The bytes depend on a secret inside the key that never leaves it. So
    the same key, credential and salt always give the same bytes, and
    nothing else can produce them.
  - With "user verification" required, the key answers only after its PIN.
    With "user presence" required, it answers only after a touch.
  - The key says whether it has `hmac-secret` (CTAP2 `getInfo`), so SafeKeep
    can refuse a key without it when it's added. Older U2F-only keys aren't
    FIDO2 at all and are refused the same way.
- **Nothing is stored on the security key.** The credential is
  *non-resident*: its ID lives in the vault's header, and only that key can
  decode it.
  - So a key can serve any number of vaults, and erasing a vault leaves
    nothing on the key to clean up.
  - The key's limited storage for resident credentials isn't used.
- **The PIN.**
  - FIDO2 PINs are at least 4 characters. SafeKeep asks for 6 or more when
    it sets one.
  - Keys allow a limited number of wrong PINs, 8 on most keys. The key
    reports its own count, and SafeKeep shows it. After 3 wrong PINs in a
    row, the key must be unplugged and plugged back in.
  - When the count runs out, the key's FIDO2 part is blocked. The only way
    out is a FIDO2 reset, which changes its secret, so that key can never
    open this vault again.
  - Keys with a fingerprint reader (YubiKey Bio, for example) also have a
    PIN, and SafeKeep uses the PIN.
- **The existing Change Master Passphrase flow** (`change-passphrase.sh`)
  locks the vault, closes Chromium, and runs native dialogs before the
  unlock prompt, so secrets never pass through the browser. Managing
  security keys works the same way.
- **The Encrypted Backup (`.7z`) has its own password**, set on the backup
  screen. This design doesn't touch it.
- **Ubuntu already recognizes FIDO2 keys by what they are, not by brand.**
  The standard device rules (`60-fido-id.rules`, part of systemd's udev)
  read a USB device's HID description and mark a FIDO2 key as a
  "security token" (`ID_SECURITY_TOKEN=1`). This is checked in the image
  when building.
- **`python-fido2`** (Yubico's library, which works with any brand) is in
  Ubuntu 24.04's archive as `python3-fido2` 1.1.2.

## How it works

### The key for each slot

Each security key that is added gets its own credential, salt and key slot.
The slot's key is:

- **Passphrase or security key / Security key only:** the 32 bytes the key
  returns, base64-encoded. LUKS's Argon2id then works on that as it does on
  a passphrase.
- **Passphrase and security key:** HMAC-SHA256, keyed with the security
  key's 32 bytes, of the passphrase (normalized the same way as today).
  Neither half alone opens the slot.

A **token** next to each slot records, in plain sight:
- the type (`safekeep-fido2`) and the key slot;
- the credential ID and the salt;
- the key's name ("Security key 1" to start; you can rename it, for
  example "Blue YubiKey" or "Spare");
- the date it was added.

One more token records the vault's choice (`passphrase`, `either`, `key`,
`both`). So the header shows that a vault uses a security key, and which
choice it has. That reveals nothing that helps open it.

### Which key slots exist in each choice

| Choice | Passphrase slot | Security key slots |
|---|---|---|
| Master Passphrase | yes | none |
| Passphrase or security key | yes | the key's bytes, one per key |
| Security key only | **none** | the key's bytes, one per key |
| Passphrase and security key | **none** | passphrase + the key's bytes, one per key |

### The code

- **`safekeep-fido2.py`** (new, in the image) is the only code that talks to
  a security key. It uses `python-fido2` over the kernel's `hidraw`.
  - Actions:
    - `list`: the keys plugged in, and whether each has `hmac-secret` and a
      PIN;
    - `set-pin`;
    - `enroll`: makes a credential, and returns the slot key and the token;
    - `unlock-key`: returns a slot key for a token.
  - Like `safekeep-passphrase.py`, secrets go through pipes, never on the
    command line or to disk, and nothing is logged.
- **`unlock-vault.sh`** reads the choice from the header and offers only
  what this vault takes:
  - **Use a security key** alongside Scan QR Code and typing (Passphrase or
    security key);
  - the security key alone (Security key only);
  - the passphrase, then the security key (Passphrase and security key).

  The steps are: "Plug in your security key" → type its PIN → "Touch your
  security key". It tries each of the vault's tokens with the key that is
  plugged in, and opens the vault with `cryptsetup open --key-slot`.
- **`manage-security-key.sh`** (new, like `change-passphrase.sh`): the app
  asks for it with a power action, `safekeep-boot.sh` locks the vault, and
  the native dialogs run before the unlock prompt.
- **The app** never sees a PIN, a passphrase or a slot key. After unlocking,
  `unlock-vault.sh` leaves only a summary in RAM for Device Options to show:
  the choice, and each key's name and date.

### Device Options → Master Passphrase

Shows **How this vault unlocks** and the security keys added, with:

- **Add a security key** — the steps:
  1. Confirm the vault with whatever opens it now.
  2. Plug in the key. A key without `hmac-secret` is refused here, with a
     plain message.
  3. Set its PIN if it has none, or type it.
  4. Touch it, and name it.

  The new slot is tested before the flow ends. At most 4 keys.
- **Remove** a key. This is refused if it would leave no way in (see
  below).
- **Change how this vault unlocks** moves between the four choices.
- **Change Master Passphrase** works as today, except:
  - in Security key only, it's hidden, and **Add a Master Passphrase**
    takes its place;
  - in Passphrase and security key, every key has to be plugged in, one
    after the other, because each slot mixes the passphrase with that key.

## Safeguards

1. **A spare security key is recommended, not required.**
   - One key is enough to move to Security key only, or Passphrase and
     security key.
   - Before the move, each key has to open the vault once in that flow. So
     a mistyped PIN or a faulty key is caught while the old way still works.
   - With only one key, the warning in 3 says so plainly, and Device Options
     suggests adding a spare to keep somewhere else.
2. **Never leave the vault without a way in.**
   - Every change adds and tests the new key slots first, and only then
     removes the old ones.
   - Before any change, the header is copied to RAM
     (`cryptsetup luksHeaderBackup`) and put back if anything fails. The
     flow ends with the old way still working.
   - Removing the last security key of a vault with no passphrase is
     refused.
3. **Plain warnings at the right moments:**
   - When setting a PIN: "After N wrong PINs this security key is locked
     for good, and can't open this vault again", with the key's own N.
   - Before Security key only, or Passphrase and security key: "If you lose
     your security key (or every security key you add), or forget the
     passphrase with Passphrase and security key, this vault can't be
     opened. Your seed backup still restores your wallet. Saved wallets,
     the Passphrase Library and notes come back only from an Encrypted
     Backup." There's a link to make one now.
   - With only one key, it adds: "Only one security key can open this
     vault. A spare kept somewhere else protects you if it's lost or
     broken."
   - The move goes ahead only after checking a box that says you
     understand.
4. **The weak-passphrase checks stay wherever a passphrase is used.**
   - Passphrase or security key, and Passphrase and security key, keep
     today's strength check.
   - Security key only has no passphrase. So the Dashboard's passphrase
     warning and the Master Passphrase rating are replaced by "This vault
     unlocks with a security key (1 added)".
5. **Factory reset** is unchanged: destroying the header removes every key
   slot and token, security key ones included.
6. **A Temporary Session** never opens the vault, so it is unaffected.
7. **Restoring an Encrypted Backup onto a new flash drive** sets up a new
   vault with a passphrase, as today. Security keys are added again there,
   since each credential belongs to one vault.

## USB: letting a security key in safely

About 30 seconds after boot, `85-safekeep-hid-lockdown.rules` turns off any
new USB keyboard-type (HID) device, and a FIDO2 key is one. Some keys have
more than one part:
- **a FIDO2 part**: HID, but not a keyboard;
- **a typing part**, such as a YubiKey's OTP: it acts as a keyboard;
- **a smart card part**: not HID.

**Why not the Coldcard approach.** The Coldcard's exception tells the
kernel's HID driver to ignore that one device ID completely. That doesn't
fit here:
- it goes by product ID, and any FIDO2 key means far too many IDs;
- the kernel takes only 4 such entries (`usbhid.quirks`);
- ignoring the device would also remove the `hidraw` access that FIDO2
  needs.

**Instead, the rule goes by what a device is.** It applies only to HID
devices that arrive after the lockdown:

1. **A boot keyboard or mouse** (the USB interface says so) is turned off,
   as today. That covers a YubiKey's OTP part.
2. **Any other HID part is kept only if Ubuntu's rules mark it as a FIDO2
   security token.** Otherwise it's turned off, as today. A late device
   that is just a keyboard is still blocked.
3. **Any keyboard or mouse input that comes from a late device is
   *inhibited* at once** (`/sys/class/input/*/inhibited`), whatever brand
   it claims to be. So a fake "security key" whose description hides a
   keyboard can't type.

This is as strong as the lockdown is today, because the existing rule also
acts as the device appears.

A security key plugged in before boot is treated like any keyboard present
at boot. For a YubiKey, that means touching it could type a code. That's
harmless, and the same as a real keyboard.

**The kernel's SysRq keys.** SafeKeep doesn't set them today, and Ubuntu
leaves some of them on. Part 1 turns them off (`kernel.sysrq = 0`), so no
keyboard can reach the kernel's own key handling. That helps the existing
lockdown too.

`test-os-lockdown.mjs` gets cases for the new rules.

## Building it

**Part 1 — security key support, "Passphrase or security key" and
"Security key only"**
- `python3-fido2` in the image (`chroot-setup.sh`), with an import check
  like the Trezor library's; a build check that `60-fido-id.rules` is
  present; the udev rules above; `kernel.sysrq = 0`.
- `safekeep-fido2.py`, `manage-security-key.sh`, the security key screens
  in `unlock-vault.sh`, and the Device Options section in `boot.html`.
- Safeguards 1–7.
- Tests:
  - a fake FIDO2 key for the helper (like the fake Trezor in
    `test-trezor-helper.py`), covering PIN, touch, wrong PINs, a blocked
    PIN, and a key without `hmac-secret`;
  - real `cryptsetup` on a small vault file for every change between
    choices, including failures halfway (like `test-change-passphrase.mjs`);
  - the USB rules;
  - the Device Options panel.

**Part 2 — "Passphrase and security key"**
- The combined key slot, Change Master Passphrase with each key, and its
  unlock screen. This is a separate part because combining two secrets into
  one key needs its own review.

Both parts add OS files, so the release that carries them needs the full
build. They can ship in one release or two.

**Testing on real hardware (the owner):**
- A FIDO2 key, probably a YubiKey 5 or a Security Key by Yubico. A second
  key helps test adding and removing a spare, but isn't needed. Other
  brands are supported, but not tried on a real device unless someone has
  one. The docs will say so.
- Go through each change between choices on a test flash drive, not the
  everyday one.
- Plug the key in before boot, and after the 30-second lockdown, both
  directly and through a hub.
