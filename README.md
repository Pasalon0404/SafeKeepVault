# SafeKeepVault

SafeKeepVault is a specialized operating system designed exclusively for high-security, air-gapped Bitcoin cryptographic operations. It runs locally as a locked-down, auditable environment, allowing users to safely manage seeds, sign complex multisig transactions, and execute cryptographic splits without ever touching an internet-connected machine.

## Core Engineering Philosophy

* **Absolute Air-Gapping:** SafeKeep OS is built to live on a dedicated, offline USB drive.
* **Minimal Supply Chain Risk:** We intentionally avoid importing massive third-party cryptographic or UR-encoding libraries. The codebase is lean, auditable, and relies on native functions wherever possible.
* **Stateless by Default:** The system features a robust "Temporary Mode" that operates entirely in RAM. All sensitive data is wiped instantly upon session termination.
* **Deterministic Data Transport:** We champion standard, unencrypted "Transfer Drives" and strict Base64/Hex/Binary file transport over brittle camera-based QR stitching for large multisig payloads.

---

## Security & Verification: Don't Trust, Verify

In the Bitcoin security ecosystem, blindly trusting a downloaded release file is a critical vulnerability. While we provide pre-packaged ZIP releases for convenience, **we actively encourage you not to trust them.**

Because SafeKeepVault is built entirely with transparent HTML and JavaScript, there are no black-box executables or hidden compiled binaries. We highly recommend that users audit the open-source code directly to verify no malicious logic exists, and then build the offline environment themselves. Compiling the code on your own machine is the only way to mathematically eliminate the risk of a compromised release file or a supply chain attack. 

---

## Building & Verification

SafeKeepVault consists of the core web application and the secure bootable USB environment. You can verify the application logic on any operating system, but creating the final bootable drive requires a Linux environment.

### 1. Verifying the Core Application (Mac, Windows, Linux)
You can compile the core cryptography app on any system with **Node.js** and **npm** installed to verify the code integrity.

**Clone the repository and install dependencies:**
```bash
git clone [https://github.com/Pasalon0404/SafeKeepVault.git](https://github.com/Pasalon0404/SafeKeepVault.git)
cd SafeKeepVault
npm install

## Developer & Architectural Documentation

If you are auditing the codebase, contributing, or simply want to understand how the stripped-down Ubuntu OS is constructed under the hood, please refer to our comprehensive **[Project Notes](PROJECT_NOTES.md)**. 

This developer handbook contains in-depth technical documentation on:
* The Vite build pipeline and offline HTML bundler.
* Partition layouts and chroot bind-mount safety patterns.
* Kiosk diagnostic halts, WebKit styling, and runtime regressions.
* Specific context for resuming development sessions with AI assistants.
