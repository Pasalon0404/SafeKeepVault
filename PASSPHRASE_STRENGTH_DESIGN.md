# Design note: refusing weak passwords

Status: **Part 1 built** (Oct 22, 2026), not yet tested on a stick or
released. Parts 2–4 are proposals.
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

Built Oct 22, 2026; not yet tested on a stick or released. Item 3 below
(the unlock warning) is not built: it ships with Part 3.

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
3. **Unlock (`unlock-vault.sh`), for existing vaults.** After a
   successful unlock, if the Master Passphrase rates Weak, the app shows a
   one-time warning on the dashboard recommending a new one (Part 3).
   Nothing is refused, since the user already depends on that vault.

### Part 2: offer a strong passphrase at setup

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

**Generate one for me** is added as a third choice, after **Scan QR Code**
and **Type Password**, for users without a password manager:
- It draws 6 words from the BIP39 list with the stick's random number
  generator (`/dev/urandom`) and shows them large, with "Write these down
  now".
- The user then types them back from the paper, which also proves they
  wrote them down correctly.

### Part 3: change the Master Passphrase

A **Change Master Passphrase** section in Device Options:
- the user enters the current passphrase and a new one (typed or
  scanned), with the same strength check;
- the OS side runs `cryptsetup luksChangeKey` on the vault, which replaces
  the key in place, so the vault's contents are not re-encrypted or
  touched.

Without this, the warning in Part 1 has nothing to point to, and a user
with a weak passphrase can only reset the stick.

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

### Testing Part 1 on a stick

Setup only runs on a new or factory-reset stick, so use a spare one.
1. Build the image with the full `sudo bash build.sh` and flash a spare
   stick. A quick update covers it too, followed by a Factory Reset.
2. **Setup, typed:**
   - `bitcoin2024`: refused, with "a common word and a year", straight
     after the first entry.
   - 4 random words: the Fair list. Close it, and you are asked again.
     Pick **Use this one anyway**, and the confirmation step follows.
3. **Setup, QR:** the password-manager QR goes straight through, with no
   extra dialog. A QR of `password` is refused.
4. **Encrypted Backup:** the bar shows Weak for 4 random words and Fair
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
3. **Prove it right away.** Generated words are typed back from the
   paper, not from memory, before the vault is made. After setup, SafeKeep
   already goes straight to the normal unlock prompt (`setup-vault.sh`,
   Phase 2), so the first unlock proves the passphrase works before any
   data goes in. That is true for a scanned QR too.
4. **Practice unlock.** A dashboard reminder two weeks after setup, then
   every six months: "Check you can still unlock your vault". It asks for
   the passphrase and checks it with
   `cryptsetup open --test-passphrase`, which opens nothing and changes
   nothing. A forgotten passphrase is then found while the user can still
   look for where they wrote it, and while the vault is still open, so
   they can make an Encrypted Backup or change the passphrase (Part 3).
   The reminder can be turned off in Device Options.
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

1. **Part 1, setup and backup**, with the shared test list. This is the
   change the owner asked for.
2. **Part 3, change passphrase**, so the unlock warning in Part 1 has
   somewhere to send users. The unlock warning and the practice unlock
   ("Not locking yourself out") ship with it.
3. **Part 2, Generate one for me.**
4. **Part 4, fixed Argon2 cost**, after measuring unlock times.

Parts 1–3 can ship in one release.
