Security & Verification
All official releases are cryptographically signed by Anton. To ensure your download has not been tampered with, please verify the signature before flashing the image to a USB drive.

1. Import the Developer Key
The public key (developer-pubkey.asc) is located in the root of this repository.
gpg --import developer-pubkey.asc

2. Verify the Release
Download the .zip, manifest.txt, and manifest.txt.asc from the Releases page. Run:
gpg --verify manifest.txt.asc manifest.txt

The key fingerprint is: 200565703351aa0bee296b6880d55f3350c01f64b32a5cc52c82e6af527bac43
