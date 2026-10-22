# Design note: refusing weak passwords

Status: **proposal, for the owner to approve.** Nothing here is built yet.
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
- **The app is 3.6 MB built.** Word and password lists add to that, so
  they need a size budget (below).

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
| Encrypted Backup password | under 50 bits | 50–69 bits | 70 bits or more |

So 4 random words are Fair for the vault and Weak for a backup; 6 random
words or a password-manager password are Strong for both.

## Proposal

### Part 1: a strength check, with a bar

**The estimator.** One small, cautious estimator, written twice from one
spec: in Python for the OS side, which enforces the rule, and in
JavaScript for the app, which shows the bar while the user types. Both
are tested against the same list of test passwords and expected bits, so
they can't drift apart.

It splits the password into the cheapest pieces an attacker would guess
and adds up their cost:
- **Common passwords**, including reversed, capitalised and l33t-speak
  forms: a bundled list of the most common passwords.
- **Words:** BIP39 words, and an English word list.
- **Patterns:** years and dates, repeats (`aaaa`), sequences (`abcd`,
  `1234`), keyboard runs (`qwerty`), and a word with digits or a symbol
  on the end.
- **Everything else** counts as random characters, at the size of the
  character set they come from.

Words from the BIP39 list are counted as randomly chosen, which is what
the generator does. A phrase the user made up from real words, such as
a line from a song, scores higher than it should. No estimator can tell;
the meter's wording says so ("a phrase you made up yourself is weaker
than it looks").

**Size budget:** about 500 KB of lists in the app, for example the 30,000
most common passwords and 30,000 English words. The BIP39 list is already
there.

An alternative is to bundle zxcvbn, the best-known estimator (MIT
licence). It is about 800 KB, and its Python port is a separate project
whose results don't always match the JavaScript. Writing our own small
one keeps both sides identical and reviewable. **Recommendation: our
own.**

**Where it runs:**
1. **First-boot setup (`setup-vault.sh`).** After the passphrase is typed
   or scanned, a helper (`safekeep-pwcheck.py`) rates it, and setup shows
   the result in a dialog:
   - **Weak:** "This passphrase is too easy to guess" with the reason (for
     example "a common password with a year added"), and back to the
     choice of Scan or Type. There is no way past it.
   - **Fair:** a warning that explains the risk and recommends 6 random
     words or a password manager, with **Use anyway** and **Choose
     another**.
   - **Strong:** setup continues without an extra dialog.

   The check works the same for a scanned QR, so a weak password put into
   a QR is still caught. The dialog never shows the passphrase itself.
   zenity can't update a bar while the user types, so setup shows the bar
   once, after entry.
2. **Encrypted Backup screen (`boot.html`).** A live bar under the
   password field, from Weak to Strong, with the reason. The Export button
   stays disabled while the password is Weak. The backup watcher in
   `safekeep-boot.sh` runs the same Python check and refuses a Weak
   password too, so the rule doesn't depend on the app alone.
3. **Unlock (`unlock-vault.sh`), for existing vaults.** After a
   successful unlock, if the Master Passphrase rates Weak, the app shows a
   one-time warning on the dashboard recommending a new one (Part 3).
   Nothing is refused, since the user already depends on that vault.

### Part 2: offer a strong passphrase at setup

Setup's choice becomes **Scan QR Code**, **Type Password** or
**Generate one for me**.
- **Generate** draws 6 words from the BIP39 list with the stick's random
  number generator (`/dev/urandom`) and shows them large, with "Write
  these down now". The user then types them back to confirm, which also
  proves they wrote them down correctly.
- Users with a password manager can keep doing what the owner suggested:
  generate a password there, turn it into a QR code with the website's QR
  generator, and scan it. That page must make the QR entirely in the
  browser and never send the password anywhere; the setup dialog and the
  docs say so.

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
   somewhere to send users. The unlock warning ships with it.
3. **Part 2, Generate one for me.**
4. **Part 4, fixed Argon2 cost**, after measuring unlock times.

Parts 1–3 can ship in one release.
