# LabBridge — Architectural Guardrails (Windows-Only Tauri v2 + Rust)

1. **Framework & IPC**: Target strictly **Tauri v2** (`tauri = "2"`, `@tauri-apps/api/core` for `invoke` and `Channel`). Never import deprecated `@tauri-apps/api/tauri` v1 modules.
2. **Pure-Rust SSH Stack**: Use `russh`, `ssh-key` (or `russh-keys`), and `russh-sftp` on `tokio`. NEVER add `ssh2` (`libssh2`), `openssl-sys`, or any crate requiring CMake/Perl/vcpkg, so `x86_64-pc-windows-msvc` builds cleanly anywhere.
3. **Terminal Packages**: Use modern scoped packages ONLY: `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`, `@xterm/addon-search`.
4. **Windows → Linux Safety**:
   - Always normalize Windows `\` path components into strict POSIX `/` strings before sending paths over SFTP or writing `tar` headers.
   - Never run automatic two-way sync on source directories (build artifacts on Linux must not flood the Windows laptop). Code sync is strictly **One-Way Auto (Local → Remote)** with on-demand Remote → Local download via SFTP Explorer.
5. **Zero-Admin Portability**: If a file named `portable.mode` exists next to `LabBridge.exe`, store all JSON configs and logs in `./data/` next to the executable; otherwise use `%APPDATA%\LabBridge`. Store passwords/passphrases via Windows Credential Manager (`keyring` crate with `windows-native` feature) without requiring Administrator privileges.
6. **UI Aesthetic**: Utilitarian dark-mode engineering workbench (slate-950/zinc-900 surfaces, high-density monospace metrics, subtle status LEDs, keyboard-first shortcuts, zero decorative bloat).

