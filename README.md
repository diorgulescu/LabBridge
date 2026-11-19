# LabBridge

[![Build & Release Windows Executable](https://github.com/diorgulescu/LabBridge/actions/workflows/build.yml/badge.svg)](https://github.com/diorgulescu/LabBridge/actions/workflows/build.yml)
[![Latest GitHub Release](https://img.shields.io/github/v/release/diorgulescu/LabBridge?label=Download%20Release)](https://github.com/diorgulescu/LabBridge/releases/latest)

**LabBridge** is a zero-admin Windows-first SSH2 + SFTP engineering workbench built with **Tauri v2**, **Pure-Rust (`russh` + `russh-sftp`)**, **React**, **TypeScript**, and **Tailwind CSS**.

It is purpose-built for hardware, firmware, and systems engineers who edit code locally on Windows using **VS Code + GitHub Copilot Agent Mode** while compiling, flashing, and testing on remote Linux lab servers and embedded targets.

> Pentru ghidul rapid în limba română destinat colegilor din echipă, consultă [README-TEAM.md](README-TEAM.md).

---

## Key Capabilities

### 1. Multiplexed Pure-Rust SSH2 Engine (`src-tauri/src/ssh/`)
- **100% Pure Rust**: Powered by `russh`, `russh-keys`, and `russh-sftp` over `tokio` (`TCP_NODELAY`) with zero CMake, OpenSSL, or `libssh2` dependencies.
- **Single Connection Multiplexing**: Shares one persistent `russh::client::Handle` across all PTY terminal tabs, SFTP directory browsers, async file transfers, and sync operations.
- **Authentication & Bastion Support**:
  - SSH Private Key (`Ed25519`, `ECDSA`, `RSA` `sha2-512`/`sha2-256`) with optional passphrase in OS Keyring
  - Password stored strictly in **Windows Credential Manager** (`keyring` `windows-native`)
  - Native **Windows OpenSSH Agent** over named pipe `\\.\pipe\openssh-ssh-agent`
  - Optional **ProxyJump (Bastion)** tunneling via `channel_open_direct_tcpip`
- **TOFU Host Key Security**: Local OpenSSH-compatible `known_hosts` store with interactive SHA-256 Trust-On-First-Use and rotated-key security prompts.
- **VPN & Reboot Resilience**: Live RTT telemetry (`Connected · XXms`) and automatic exponential-backoff reconnection (`1s, 2s, 5s, 10s`) that seamlessly re-establishes SFTP and runs a delta workspace sync upon recovery.

### 2. Real-Time AI & Git-Aware One-Way Sync (`src-tauri/src/sync/`)
- **Git Lock & Copilot Burst Guard**: Recursive `350 ms` debounced watcher (`notify-debouncer-full`) that detects `.git/index.lock` / `.git/HEAD.lock`, holds dirty paths in memory (`Waiting on Git lock...`), and waits an extra `250 ms` quiet window after Git operations settle before pushing.
- **Ignore Filtering**: Evaluates `.gitignore`, `.git/info/exclude`, and optional `.labignore` via the `ignore` crate while hard-excluding `.git/`, `.labbridge.tmp.*`, and configurable build folders (`build/`, `out/`, `target/`, `.vscode/`).
- **Windows → Linux Stream Sanitizer**: Converts `CRLF -> LF` purely in memory during upload for scripts and build files (`.sh`, `.bash`, `.py`, `.pl`, `Makefile`, `*.mk`, `Kconfig`, and `#!` shebangs) without modifying local Windows files, while preserving `0755` executable permissions.
- **Dual-Path Hybrid Uploader**:
  - **Fast Path (1–3 files < 2 MB)**: Concurrent atomic SFTP upload to `.labbridge.tmp.<name>` + POSIX `chmod` + atomic `rename`.
  - **Batch Stream Path (4+ files, ≥ 2 MB, or Workspace Reconcile)**: Streams a compressed `.tar.gz` archive (`tar` + `flate2`) directly into `tar -xzf - -C '<remote_root>'` over SSH `exec`.
- **Fast Parallel Reconciliation**: Compares parallel local `rayon` SHA-256 digests against remote `find ... -exec sha256sum {} +` in milliseconds, supporting both **Check Dry-Run** and **Push Diff**.

### 3. Dual-Pane Local ↔ SFTP Explorer (`src/components/explorer/`)
- **Split Local & Remote File Manager**: Breadcrumb navigation, quick path jump, instant filter, sortable columns, POSIX permission display (`rwxr-xr-x` / `0755`), and one-click **Open Workspace in VS Code** (`CREATE_NO_WINDOW` detached spawn).
- **Async Transfer Queue**: Background upload & recursive directory download worker (for pulling logs, binaries, and core dumps) streaming live throughput (`MB/s`) over `tauri::ipc::Channel` with `CancellationToken` support.
- **Quick SHA-256 Diff Modal**: Side-by-side line diff and `sha256sum` verification between local and remote files.
- **Follow Terminal Directory**: Tracks shell `cd` navigation via OSC 7 escape sequences (with a one-click **Inject Prompt Hook** helper for Bash/Zsh).

### 4. Multi-Tab Terminal & Hardware Macro Bar (`src/components/terminal/`, `src/components/macros/`)
- **GPU-Accelerated Terminal**: Multi-tab `@xterm/xterm` (`xterm-256color`) with `@xterm/addon-webgl` (and automatic canvas fallback), `@xterm/addon-fit`, `@xterm/addon-search`, raw `Channel<Vec<u8>>` streaming, and instant in-place shell reopen on `Enter` after disconnects.
- **Per-Profile Build & Hardware Macros (`Alt+1`–`Alt+5`)**: Customizable action buttons (`Build`, `Run CTest`, `Flash Target`, `Serial / dmesg`, `Clean`) supporting *Active Terminal* or *Dedicated Output Tab* execution and *Flush pending sync before running*.

---

## Zero-Admin Portability

- If a file named `portable.mode` exists next to `LabBridge.exe`, all JSON configurations (`profiles.json`, `ui_state.json`), `known_hosts`, and logs are stored in `./data/` next to the executable.
- Otherwise, LabBridge uses `%APPDATA%\LabBridge`.
- Passwords and key passphrases are never written to disk; they are stored in **Windows Credential Manager** without requiring Administrator rights.

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Alt+1` .. `Alt+5` | Trigger profile hardware/build macros 1–5 |
| `Ctrl+Shift+T` | Open new multiplexed SSH terminal tab |
| `Ctrl+Shift+W` | Close active terminal tab |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / Paste in terminal |
| `Ctrl+Shift+F` | Search in terminal scrollback |
| `Ctrl+J` | Maximize / restore terminal dock |
| `Ctrl+,` | Open Profile, Keyring & Known Hosts settings |

---

## Building from Source

### Prerequisites
- **Node.js** 20+ and `npm`
- **Rust** stable toolchain (`x86_64-pc-windows-msvc` on Windows)

### Development
```bash
npm install
npm run tauri dev
```

### Build Zero-Admin Portable `.zip` (`LabBridge.exe` + `portable.mode`)
- **On Windows (PowerShell)**:
  ```powershell
  npm run package:portable:win
  ```
- **Cross-compiling from macOS / Linux (`cargo-xwin`)**:
  ```bash
  npm run package:portable:xwin
  ```
Both commands output `dist-portable/LabBridge-Portable.zip` containing `LabBridge.exe`, `portable.mode`, and `README-TEAM.md`.

### Automated GitHub Actions Builds & Releases
Every push to `main`, version tag (`v*`), published GitHub Release, or manual workflow dispatch runs [`.github/workflows/build.yml`](.github/workflows/build.yml) on `windows-latest`, executing the Rust unit/integration test suite, compiling `LabBridge.exe` (`LTO = thin`, `strip = true`), and automatically publishing `LabBridge-Portable.zip`, `LabBridge.exe`, and `SHA256SUMS.txt` directly to [GitHub Releases](https://github.com/diorgulescu/LabBridge/releases).

---

## Contributors

- **Dragoş Iorgulescu** ([@diorgulescu](https://github.com/diorgulescu)) — Creator & Lead Engineer
- **Antigravity** (Google DeepMind) — Architecture & Implementation Contributor
