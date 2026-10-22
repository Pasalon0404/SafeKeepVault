# Design note: refusing weak passwords

Status: **Parts 1, 2 and 3 built** (Oct 22, 2026). Parts 1 and 2 were
tested on a stick (Weak refused at setup; Generate One for Me with its QR
code scanned back and used to unlock). Part 3 is not yet tested on a
stick. None is released. Part 4 is a proposal.
The owner decided (Oct 22, 2026) that a weak Master Passphrase is refused,
not just warned about.

## The problem

Someone who steals a SafeKeep stick can copy the vault file and guess
passwords on their own computers, as fast and for as long as they can
afford. The encryption is sound, so the password is the only thing in the
way. Today SafeKeep accepts any password at all, even one character, so a
user who picks `bitcoin2024` has a vault that a password list opens in
minutes.

The Encrypted Backup (`.7z`) has the same problem, and it is worse there:
the backup is meant to be copied to an everyday computer, and 7z's key
derivation makes each guess cheap.

## Facts the design rests on

- **Every password that protects data is set in one of two places:**

  | Password | Set in | Checks today | How guesses are slowed |
  |---|---|---|---|
  | Master Passphrase (the vault) | `setup-vault.sh`, first boot: typed (twice) or a QR scan | Not empty; typed entries match | LUKS2 with Argon2id (cryptsetup defaults, see below) |
  | Encrypted Backup | `boot.html` backup screen: typed (twice) or a QR scan; made by the backup watcher in `safekeep-boot.sh` | Not empty; typed entries match | 7z: SHA-256, 2^19 rounds, fixed by 7z |

  Encrypted Notes and the passphrase library are plain files inside the
  vault, protected by the Master Passphrase. The separate `secure-note`
  page is not part of `boot.html`.
- **There is no way to change the Master Passphrase** after setup. Nothing
  calls `luksChangeKey` or `luksAddKey`. A user with a weak one can only
  back up, reset and set up again.
- **The vault's guess cost depends on the setup computer.**
  `setup-vault.sh` runs `cryptsetup luksFormat` with no options, so
  cryptsetup 2.7 (Ubuntu 24.04) uses its defaults: LUKS2 and Argon2id,
  timed to take about 2 seconds on that computer, using up to 1 GiB of
  memory (less if the computer has little RAM). A slow or small laptop
  gets a cheaper vault.
- **7z guesses are cheap.** One gaming graphics card tests very roughly
  hundreds of thousands of 7z passwords a second, against perhaps tens per
  second for the vault. A backup password therefore needs to be stronger
  than a vault password to be equally safe.
- **The pieces this needs already exist:**
  - `python3` is in the image, and `safekeep-boot.sh` already runs Python
    helpers.
  - The app has a 4-, 6- or 8-word BIP39 passphrase generator (Cipher
    tool, `pp_generate`), using `crypto.getRandomValues`, with an entropy
    readout for what it generates.
  - The app has the BIP39 English wordlist.
- **The app was 3.7 MB built** before Part 1; the word lists bring it
  to 4.3 MB (see Part 1).

## How strong is strong enough

Strength is measured as **bits**: log2 of the number of guesses a smart
attacker needs. An attacker tries common passwords, words and patterns
first, so `Tr0ub4dor&3` is worth far fewer bits than its length suggests.

| Bits | Examples | Vault (Argon2id) | Backup (7z) |
|---|---|---|---|
| under 30 | `bitcoin2024`, a pet's name and a year | minutes to days | seconds |
| about 44 | 4 random BIP39 words | years for a well-funded attacker | hours to days |
| about 66 | 6 random BIP39 words | out of reach | out of reach for anyone realistic |
| 100+ | 20 random characters from a password manager | out of reach | out of reach |

**Proposed bands:**

| | Weak: refused | Fair: warned, "Use anyway" | Strong |
|---|---|---|---|
| Master Passphrase | under 40 bits | 40–59 bits | 60 bits or more |
| Encrypted Backup password | under 50 bits | 50–64 bits | 65 bits or more |

So 4 random words are Fair for the vault and Weak for a backup; 6 random
words or a password-manager password are Strong for both.

## Proposal

### Part 1: a strength check, with a bar — built

Built Oct 22, 2026, and tested on a stick. Item 3 below (the unlock
warning) was built with Part 3.

**The estimator.** One small, cautious estimator, written twice:
`seed-xor-tool/shared/pwcheck.js` draws the bar in the app, and
`usbbootdrive/safekeep-pwcheck.py`, a line-by-line port, enforces the
rule on the stick. `test-pwcheck.mjs` runs both on about 2,800 passwords
and requires the same bits, band, reasons and message, so they can't
drift apart.

It splits the password into the cheapest pieces an attacker would guess
and adds up their bits:
- **Words:** a piece found in the word lists costs log2 of its rank,
  times its capitalisation and l33t-speak variations, times 2 if
  reversed. This catches common passwords, English words and names.
- **Patterns:** years 1900–2049, repeats (`aaaa`, `abcabc`) and
  sequences (`abcd`, `4321`). Keyboard runs such as `qwerty` are in the
  common-password list.
- **Everything else** counts character by character: 10 for a digit, 26
  for a letter, 33 for other printable ASCII, 100 for anything else.
- Each word or pattern adds 1 bit for "which kind of piece comes next".
- **Separators:** a password made of parts joined by one separator
  (space, `-`, `_`, `.`, `,`, `+`, `/`) pays for the separator once
  (3 bits), not at every join.
- **Random words:** 3 or more lowercase BIP39 words joined by a separator
  count a full 11 bits each, since that is what a generator makes. A
  phrase someone made up from BIP39 words is overrated by this; nothing
  can tell. Too few of them gets its own message: "Random words are good,
  but each adds only about 11 bits: use more of them."

Results: `bitcoin2024` 23 bits, `Summer1990!` 21, `Tr0ub4dor&3` 44,
4 random words 47, 5 random words 58, 6 random words 69, a 20-character
password-manager password about 88.

**Word lists** (`usbbootdrive/pwcheck-lists.json`, 580 KB): zxcvbn
4.4.2's lists (MIT licence), cut to the 30,000 most common passwords,
20,000 English words, 10,000 words from TV and film, 5,000 surnames and
about 3,000 first names, plus the BIP39 list.
`usbbootdrive/make-pwcheck-lists.py` makes the file. The app bundles the
same file, which adds about 0.6 MB to `boot.html`.

**Where it runs:**
1. **First-boot setup (`setup-vault.sh`).** A scanned passphrase is rated
   straight after the scan; a typed one after the first entry, before the
   confirmation, so a Weak one isn't typed twice. The passphrase goes to
   the checker on stdin and no dialog shows it.
   - **Weak:** "Passphrase Too Easy to Guess", with the strength in bits
     and the reason (for example "It is mostly a name and a year, which
     attackers try first"), and back to choosing a passphrase. There is no
     way past it.
   - **Fair:** a list with **Choose another passphrase** (highlighted, so
     Enter picks it) and **Use this one anyway**. Closing the dialog also
     means choose another, so only a deliberate pick keeps it.
   - **Strong:** setup continues without an extra dialog, so the password
     manager → QR route looks exactly as before.
   - If the checker itself fails (it can't on a correct build: `build.sh`
     stops without it), setup says the strength couldn't be checked and
     continues, rather than leaving a stick that can't be set up.
2. **Encrypted Backup screen (`boot.html`).** A bar under the password
   field shows Weak, Fair or Strong, the bits and the reason, updated as
   the user types or scans. **Export Backup** refuses a Weak password
   with a message. The backup watcher in `safekeep-boot.sh` runs the
   Python check too and refuses a Weak password without running 7z, so
   the rule doesn't depend on the app alone.
3. **Unlock (`unlock-vault.sh`), for existing vaults.** Built with Part 3:
   after a successful unlock, the passphrase is rated and only the result
   is left for the app. If it is Weak, the dashboard shows a warning with a
   **Change Master Passphrase** button. Nothing is refused, since the user
   already depends on that vault.

### Part 2: offer a strong passphrase at setup — built

**The recommended route doesn't change.** The website's docs recommend:
generate a fully random password of 20+ characters in a password manager,
turn it into a QR code with the website's in-browser QR generator, save
the QR on the phone (as a file, or in the password manager), and scan it
at setup and at every unlock. The QR opens nothing without the stick, so
keeping it on the phone is a fair trade for never typing the password.
That keeps working exactly as today:
- **Scan QR Code** stays the first choice in setup, so Enter still picks
  it.
- A password-manager password rates Strong, so setup shows no extra
  dialog and continues as it does now.
- No "write it down" step: the docs tell these users the password
  manager is its home and not to write it down, and setup follows that.

**Generate One for Me** is added as a third choice, after **Scan QR Code**
and **Type Password**, for users without a password manager. The choice
list now shows even without a camera (Type, Generate), and its text points
users without a password manager to it.
- `safekeep-pwcheck.py --generate 6` draws 6 words from the BIP39 list
  with Python's `secrets` module (the kernel's random number generator):
  about 66 bits, Strong for the vault and for a backup.
- **One screen, phone or paper.** Setup shows the passphrase as a QR code
  and as 6 numbered words, three to a line, and asks the user to save it
  "one way or both": scan the QR code into a phone's password manager (with
  the phone's camera or the Courier Tool), write the words on paper, or do
  both. Nobody is made to write the words down. The QR code holds exactly
  the words, lowercase with one space between them, so **Scan QR Code** at
  unlock works with it, and so does typing the words.
- **Check Your Copy.** Before the vault is locked with it, the copy is
  checked:
  - **Scan it back from my phone** (when there is a camera and a QR code):
    the user shows the saved QR code to the camera. It must read exactly
    the words. A different code, or nothing read in 30 seconds, says so
    and asks again.
  - **Type the words**: typed back from the paper, exactly. **Back** returns
    to the check choice.
  - **Show the passphrase again**, or closing the check, goes back to the
    screen with the QR code and words. Closing that screen goes back to the
    method choice, and a new Generate gives new words.
- The QR code is drawn with `qrencode` in block characters and never
  written anywhere. `qrencode` is a package added in `chroot-setup.sh`, so
  it needs a full build; a stick without it shows the words only, and the
  check is typing.
- **Screen size.** Setup's dialogs run at double size (`GDK_SCALE=2`), so a
  1920×1080 screen gives them only 960×540 to work with. Checked by
  rendering the real dialogs with zenity 4.0.1 at double size on
  1920×1080:
  - the QR code is drawn at Pango size `small`, which fits the passphrase
    screen in 1,016 pixels and still decodes with `zbarimg`, including
    with the longest possible words (53 characters, a version 3 QR);
  - zenity doesn't wrap the text above a list, so every list's text is
    broken into lines of at most about 64 characters, and the strength
    message is wrapped with `fold`. Before, the Fair warning and the older
    Vault Created dialog ran off the side of a 1080p screen.
  `test-pwcheck.mjs` checks the line lengths and the list heights.

**No more dead ends on Cancel.** Before, Cancel anywhere in setup ended
it, and the boot script then showed "Setup Incomplete" and left a black
screen. Now:
- Cancel in a typed entry, its confirmation, or Generate One for Me goes
  back to the method choice.
- Cancel on the welcome dialog, or closing the method choice, asks
  **Setup Isn't Finished**: **Go back to setup** (highlighted, and also
  what closing the dialog does) or **Shut down**. After shutting down,
  setup starts again at the next power-on.
- If setup still fails for a real reason (no room for the vault), the
  boot script says so and shuts down instead of leaving a black screen.

### Part 3: change the Master Passphrase — built

Built Oct 22, 2026; not yet tested on a stick.

**Lock, change, unlock.** The owner chose this over a form in the app
(Oct 22, 2026). The app would have had to pass the old and new passphrase
to the OS through the download folder, which on a normal boot is inside
the vault, so they would have been written into it and deleted. Instead:
1. **Device Options → Master Passphrase → Change Master Passphrase**
   explains that SafeKeep will lock (unsaved work is lost), and **Lock and
   Change** sends the power action `passphrase`.
2. `safekeep-boot.sh` locks exactly as Lock does: Chromium closed, the
   vault unmounted, the LUKS key evicted. It re-runs itself with
   `SAFEKEEP_CHANGE_PASSPHRASE=1`, and the new run starts
   `change-passphrase` before the unlock prompt. If the signal is lost, the
   default is a plain lock.
3. `change-passphrase.sh`, in native dialogs:
   - asks for the current passphrase (scan or type) and checks it opens the
     vault (`cryptsetup open --test-passphrase`);
   - asks for the new one on the same screens as setup: scan, type twice,
     or Generate One for Me with its QR code and checked copy, with the
     same strength check. The screens are shared through
     `passphrase-dialogs.sh`, which `setup-vault.sh` now sources too;
   - refuses the same passphrase as now;
   - runs `safekeep-passphrase.py change` (as root), which runs
     `cryptsetup luksChangeKey`. That replaces the key slot; the vault's
     contents and master key are not touched. The helper then checks that
     the new passphrase opens the vault and the old one doesn't.
   Every way out (**Keep Current Passphrase**, closing a choice, an error)
   says the passphrase wasn't changed.
4. The normal unlock prompt follows, so the first unlock with the new
   passphrase proves it works.

The passphrases reach `cryptsetup` through pipes (`/dev/fd/N`): never a
command line, a file or the browser.

**Weak warning.** `unlock-vault.sh` rates the passphrase after a successful
unlock and leaves only `{"band", "bits"}` in
`/tmp/safekeep-signals/PASSPHRASE_RATING.json` (RAM, cleared on every
unlock). The app shows it in the Master Passphrase section, and the
dashboard shows a red **Weak Master Passphrase** banner with a **Change
Master Passphrase** button when it is Weak.

**Practice unlock: dropped.** Every SafeKeep session already starts by
unlocking the vault, so a reminder to check the passphrase still works
adds nothing. The Master Passphrase section instead suggests checking a
paper copy now and then: lock, then unlock with **Type Password** and the
words from the paper.

Tests: `test-change-passphrase.mjs` runs the helper on a real LUKS2 file
and the whole `change-passphrase.sh` with stand-ins for zenity, blkid,
mount and losetup (where `cryptsetup` is installed; it says so where it
isn't), plus the wiring. The dialogs were rendered at double size on
1920×1080.

### Part 4: a fixed minimum cost for the vault

Make `luksFormat` (and `luksChangeKey`) use explicit settings instead of
whatever the setup computer's benchmark gives: LUKS2, Argon2id, 1 GiB of
memory, 4 threads, and a fixed minimum number of rounds. Then a vault made
on a slow laptop is as costly to guess as one made on a fast one. The
round count needs measuring on the ZBook and on the slowest laptop we
support, so unlock stays under about 5 seconds. Computers with under
2 GiB of RAM can't open a 1 GiB vault; setup would say so and stop.

Existing vaults keep their settings until the passphrase is changed
(Part 3), which writes the new key with the new settings.

### Testing Parts 1 and 2 on a stick

Setup only runs on a new or factory-reset stick, so use a spare one.
1. Build the image with the full `sudo bash build.sh` and flash a spare
   stick. A quick update covers it too, followed by a Factory Reset.
2. **Setup, typed:**
   - `bitcoin2024`: refused, with "common words and a year", straight
     after the first entry.
   - 4 random words: the Fair list. Close it, and you are asked again.
     Pick **Use this one anyway**, and the confirmation step follows.
3. **Setup, QR:** the password-manager QR goes straight through, with no
   extra dialog. A QR of `password` is refused.
4. **Cancel:** after a Weak passphrase, press Cancel in the typed entry:
   you're back at the method choice. Close the method choice: **Setup
   Isn't Finished** asks, and **Go back to setup** returns to it.
5. **Generate One for Me** (full build): the QR code and the 6 numbered
   words show together. Scan the QR code into your phone's password
   manager, then **Check Your Copy → Scan it back from my phone**: setup
   goes on without anything typed. Try once more with **Type the words**
   and one wrong word: "That Doesn't Match". At the unlock prompt that
   follows, **Scan QR Code** with the phone, or **Type Password** with the
   words, opens the vault.
6. **Encrypted Backup:** the bar shows Weak for 4 random words and Fair
   for 5. Export refuses the Weak one. A password-manager password shows
   Strong and exports.

## Not locking yourself out

Refusing weak passwords protects against a thief, but it raises the other
risk: a user who can't use an easy password may make up a clever one and
forget it. There is no recovery without the passphrase; that is what keeps
the vault safe from a thief. SafeKeep can't keep a copy, so the design has
to make the passphrase easy to keep.

**What a forgotten Master Passphrase costs.** The bitcoin itself is not
lost: the paper seed backup restores the wallet on a reset stick, or in
any wallet. What is lost is everything that lives only in the vault:
saved BIP39 passphrases, Encrypted Notes, 2FA backups and saved wallets.
For a user whose BIP39 passphrase exists only in the vault, that *is*
losing the funds.

**How the design keeps the passphrase recoverable:**
1. **Words, not random characters.** "Generate one for me" (Part 2) gives
   6 BIP39 words. They are Strong, and easy to write down, read back and
   type, unlike a string such as `x7#Qp…`.
2. **A Master Passphrase card, for Generate and Type only.** Setup asks
   the user to write the passphrase on paper and keep it like the seed backup: with it, or
   somewhere separate. Users already do this for their 12 or 24 words.
   The docs give the trade-off: kept together, one find gives a thief
   both; kept apart, both must be found again later. Users on the QR
   route are not asked to: their password manager is the copy.
3. **Prove it right away.** A generated passphrase is checked before the
   vault is made: scanned back from the phone, or typed back from the
   paper, not from memory. After setup, SafeKeep
   already goes straight to the normal unlock prompt (`setup-vault.sh`,
   Phase 2), so the first unlock proves the passphrase works before any
   data goes in. That is true for a scanned QR too.
4. **Check the paper copy.** Every session starts by unlocking, which
   proves the passphrase works, but someone who always scans the QR code
   never tests their paper. The Master Passphrase section suggests locking
   now and then and unlocking with the words from the paper. (A reminder
   was proposed here and dropped for the reason above.)
5. **Change it later (Part 3).** A user who starts using a password manager
   can move to a password from it without resetting the stick.
6. **The phone can't be the only copy.** On the QR route, the password
   itself stays in the password manager, which has its own backup. The
   website's docs say this; setup's QR dialog repeats it in one line. A
   lost phone must not mean a lost vault.
7. **Fair is allowed.** Only Weak is refused. A memorable passphrase in
   the Fair band, such as 4 random words, can still be used after the
   warning.

**Encrypted Backup passwords** have the same risk with a twist: a backup
is made to be restored, often long after. The backup screen says to keep
its password on the Master Passphrase card or in a password manager. The
app already recommends using the Master Passphrase itself ("to prevent
password fatigue"), and that stays: one less password to lose. The same
password then needs the backup rules too, so a Master Passphrase that is
Fair for the vault but Weak for a backup (such as 4 random words) is
refused on the backup screen, with "choose a longer one for both, or a
separate one for backups". A password-manager password passes both. The
backup screen and the docs also say not to leave backup copies on an
everyday computer: away from the stick, a copy needs only the password
(or the unlock QR) to open.

## Risks and open questions

- **The estimator is a guess.** It can't know how a password was made, so
  it can only catch the common mistakes. The bar's wording and the docs
  steer users to generated passphrases rather than to "beating the bar".
- **Refusing locks out some current habits.** A user who reflashes and
  sets up again with their old weak passphrase will be refused. That is
  the point, but the message must say what to do instead.
- **The two estimators must match.** The shared test list is the
  safeguard; a test fails if the Python and JavaScript bits differ.
- **List licences.** The password and word lists must be ones we may ship
  (for example the MIT-licensed lists from the SecLists project). To check
  before building.
- **BIP39 passphrases (the "25th word") are out of scope here.** They
  don't encrypt anything stored on the stick, but they are weaker against
  guessing than the vault: someone holding the seed words can test
  millions a second. A later change could show the same bar on the
  passphrase screens as a warning only.
- **Not in scope:** someone forcing the user to unlock (coercion), and an
  attacker who can change the stick's software.

## Suggested order

1. **Part 1, setup and backup**, with the shared test list — built.
2. **Part 3, change passphrase**, with the weak-passphrase warning —
   built.
3. **Part 2, Generate One for Me** — built (with the Cancel fixes).
4. **Part 4, fixed Argon2 cost**, after measuring unlock times.

Parts 1–3 can ship in one release.
