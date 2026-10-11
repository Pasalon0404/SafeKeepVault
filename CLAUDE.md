# Notes for Claude

## Where the app runs
- SafeKeepVault (`seed-xor-tool/boot.html`) runs only on desktop and laptop computers, booted from the SafeKeep USB stick. It is never used on a phone.
- Don't design for, test at or mention phone widths for this app. Check layouts at laptop and desktop window sizes.
- The online Courier Tool (separate repo, Pasalon0404/safekeep-companion) is a web app and can be opened on phones. This note applies only to SafeKeepVault.

## Releases
- Merge features and small changes to `main` without bumping `seed-xor-tool/VERSION`. Builds from `main` are for the owner's own use only.
- Bump the version, write release notes, push a tag or prepare website changes only when the owner says it's time for a release.
