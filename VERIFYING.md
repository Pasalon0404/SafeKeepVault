# Verifying a SafeKeepVault release

Each [GitHub Release](https://github.com/Pasalon0404/SafeKeepVault/releases)
publishes the app, `boot.html`, together with four independent ways to check
it. Do these checks on the computer you will copy the file from. Do not run
SafeKeep from a file you have not checked.

| File / record | What it proves |
|---|---|
| `SHA256SUMS` | The download is not corrupted. On its own it proves nothing about who made it. |
| `SHA256SUMS.asc` | The maintainer, holding the key in [`developer-pubkey.asc`](developer-pubkey.asc), signed these exact hashes. |
| GitHub artifact attestation | This repository's release workflow built these exact bytes from the tagged commit (Sigstore, keyless). |
| `boot.html.ots` | The file's hash existed no later than a particular Bitcoin block (OpenTimestamps), independently of GitHub. |
| Reproducible build | Anyone can rebuild the stamped commit from source and get the same bytes, so you don't have to trust the build machine. |

The checksum, signature and attestation take a minute. The rebuild is the
strongest check, and it is also the slowest.

## 1. Checksum

Download `boot.html` and `SHA256SUMS` into the same folder, then:

```sh
sha256sum -c SHA256SUMS            # Linux
shasum -a 256 -c SHA256SUMS        # macOS
```

Expect `boot.html: OK`.

## 2. Maintainer signature (GPG)

```sh
gpg --import developer-pubkey.asc
gpg --fingerprint anton@safekeepbitcoin.com
gpg --verify SHA256SUMS.asc SHA256SUMS
```

The key's fingerprint must be:

```
A333 EB82 6F70 A79A 736F  0994 8EA7 DD8C EDBA 86C2
```

Expect `Good signature from "Anton <anton@safekeepbitcoin.com>"`. GPG may also
warn that the key is "not certified with a trusted signature". That only means
you haven't certified the key yourself. Compare the fingerprint against a copy
from a second source before you rely on it, rather than trusting the one in
this repository alone. The signature is added by hand after the release
workflow finishes, so a brand-new release may not have it yet.

## 3. Build provenance (GitHub attestation)

With the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify boot.html -R Pasalon0404/SafeKeepVault
```

This checks a Sigstore-signed statement that the `Release` workflow in this
repository produced exactly these bytes, and it names the commit and workflow
run. It doesn't depend on the maintainer's key, so it is a separate check from
the signature.

## 4. Timestamp (OpenTimestamps)

```sh
pip install opentimestamps-client
ots info boot.html.ots              # shows whether the proof is complete
ots verify boot.html.ots            # needs a local Bitcoin Core node (pruned is fine)
```

A new release's proof is *pending* for a few hours, until a Bitcoin block
confirms it. The `Upgrade OpenTimestamps proof` workflow then replaces the
file with the complete proof. Don't treat it as timestamped until `ots info`
shows a `BitcoinBlockHeaderAttestation`.

## 5. Rebuild from source (reproducible build)

The version stamp inside `boot.html` (welcome screen and dashboard footer,
e.g. `v1.36 · build 64 · 1a2b3c4 · 2026-10-07`) names the exact commit it was
built from. To rebuild that commit and compare it byte for byte, you need Git
and Node.js 22:

```sh
git clone https://github.com/Pasalon0404/SafeKeepVault.git   # a full clone, not --depth 1
cd SafeKeepVault/seed-xor-tool
npm run verify-release -- /path/to/boot.html --sums /path/to/SHA256SUMS
```

`verify-release` checks the checksum, reads the stamped commit, builds it in a
temporary git worktree (`npm ci && npm run build`) and compares the result. It
prints `MATCH` (exit 0) or `MISMATCH` (exit 1). It refuses a file stamped
`+ local changes` (built from uncommitted source) or `+ shallow clone`
(built in a clone missing history, so its build number is wrong).

Two details make the build reproducible:

- **The build number is the commit count.** A shallow clone counts fewer
  commits and stamps a different number, so the clone must be complete
  (`git fetch --unshallow` fixes a shallow one).
- **The stamp and `manifest.json` use the commit's date, not the build
  time.** The commit hash is always 7 characters, so builds don't depend on
  the clock or on local git settings.

The release workflow builds every release twice and requires identical bytes.
Rebuilds on Linux match. If you rebuild on macOS or Windows, please report
whether it matched.

## 6. On the USB stick

`sudo bash quick-update.sh` prints the full `app sha256` of the `boot.html`
it is about to install. Before flashing, check that it equals the release's
`SHA256SUMS`.

---

## For the maintainer: making a release

1. Bump `seed-xor-tool/VERSION` (e.g. `1.36`), commit and push to `main`.
2. Tag the commit and push the tag. The tag must match `VERSION`:
   ```sh
   git tag v1.36 && git push origin v1.36
   ```
   The `Release` workflow then does the following:
   - runs every test;
   - builds `boot.html` twice and requires identical bytes;
   - refuses a `+ local changes` or `+ shallow clone` stamp;
   - writes `SHA256SUMS`;
   - creates the attestation and a pending OpenTimestamps proof;
   - publishes the GitHub Release.
3. Check the release yourself, then sign it offline:
   ```sh
   gh release download v1.36 --pattern boot.html --pattern SHA256SUMS
   (cd /path/to/SafeKeepVault/seed-xor-tool && npm run verify-release -- "$OLDPWD/boot.html" --sums "$OLDPWD/SHA256SUMS")
   gpg --local-user A333EB826F70A79A736F09948EA7DD8CEDBA86C2 --armor --detach-sign SHA256SUMS
   gh release upload v1.36 SHA256SUMS.asc
   ```
4. Build the USB image from the released `boot.html`, not a local build,
   so the stick runs exactly the attested bytes. Copy it into
   `usbbootdrive/src/dist/boot.html`, and check `app sha256` in the
   quick-update output.
