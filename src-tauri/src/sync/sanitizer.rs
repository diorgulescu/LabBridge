use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::RwLock;
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

use crate::error::AppResult;

/// Per-profile in-memory cache of remote file POSIX octal modes (`rel_posix -> mode`),
/// populated during initial workspace tree scan and updated after every sync batch.
#[derive(Default)]
pub struct RemoteModeCache {
    modes: RwLock<HashMap<String, u32>>,
}

impl RemoteModeCache {
    pub fn new() -> Self {
        Self {
            modes: RwLock::new(HashMap::new()),
        }
    }

    pub fn replace_all(&self, next: HashMap<String, u32>) {
        if let Ok(mut guard) = self.modes.write() {
            *guard = next;
        }
    }

    pub fn get(&self, rel_posix: &str) -> Option<u32> {
        self.modes
            .read()
            .ok()
            .and_then(|g| g.get(rel_posix).copied())
    }

    pub fn set(&self, rel_posix: String, mode: u32) {
        if let Ok(mut guard) = self.modes.write() {
            guard.insert(rel_posix, mode & 0o7777);
        }
    }

    pub fn remove(&self, rel_posix: &str) {
        if let Ok(mut guard) = self.modes.write() {
            guard.remove(rel_posix);
        }
    }
}

#[derive(Debug, Clone)]
pub struct PreparedSyncFile {
    pub rel_posix: String,
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub mode: u32,
    pub mtime: u64,
    pub crlf_converted: bool,
}

/// Checks whether a relative POSIX path + payload qualifies for in-memory `CRLF -> LF` conversion.
/// Default policy covers: `.sh`, `.bash`, `.py`, `.pl`, `Makefile`, `*.mk`, `Kconfig`, and `#!` shebang scripts.
pub fn should_convert_crlf(rel_posix: &str, raw_bytes: &[u8]) -> bool {
    let check_len = raw_bytes.len().min(8192);
    if raw_bytes[..check_len].contains(&0) {
        return false; // Never touch binary files
    }

    if raw_bytes.starts_with(b"#!") {
        return true;
    }

    let file_name = rel_posix.rsplit('/').next().unwrap_or(rel_posix);
    if matches!(file_name, "Makefile" | "makefile" | "GNUmakefile" | "Kconfig")
        || file_name.starts_with("Kconfig.")
    {
        return true;
    }

    if let Some((_, ext)) = file_name.rsplit_once('.') {
        if matches!(
            ext.to_ascii_lowercase().as_str(),
            "sh" | "bash" | "py" | "pl" | "mk"
        ) {
            return true;
        }
    }

    false
}

/// Converts `\r\n` sequences to `\n` strictly in memory without touching disk.
pub fn convert_crlf_to_lf(raw: Vec<u8>) -> (Vec<u8>, bool) {
    if !raw.windows(2).any(|w| w == b"\r\n") {
        return (raw, false);
    }

    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'\r' && i + 1 < raw.len() && raw[i + 1] == b'\n' {
            out.push(b'\n');
            i += 2;
        } else {
            out.push(raw[i]);
            i += 1;
        }
    }
    (out, true)
}

/// Preserves `0755` if the file already had execute bits on remote OR starts with `#!` shebang
/// OR ends in `.sh`; otherwise uses `0644`.
pub fn resolve_target_mode(
    rel_posix: &str,
    payload: &[u8],
    cached_remote_mode: Option<u32>,
) -> u32 {
    if cached_remote_mode.map_or(false, |m| (m & 0o111) != 0) {
        return 0o755;
    }
    if payload.starts_with(b"#!") {
        return 0o755;
    }
    if rel_posix.to_ascii_lowercase().ends_with(".sh") {
        return 0o755;
    }
    0o644
}

/// Reads a local file into memory, applies optional `CRLF -> LF` sanitization without modifying
/// the local file, resolves its target Linux POSIX mode, and computes its SHA-256 digest.
pub fn prepare_file_for_sync(
    abs_path: &Path,
    rel_posix: &str,
    crlf_guard_enabled: bool,
    cached_remote_mode: Option<u32>,
) -> AppResult<PreparedSyncFile> {
    let meta = fs::metadata(abs_path)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let raw = fs::read(abs_path)?;
    let (bytes, crlf_converted) = if crlf_guard_enabled && should_convert_crlf(rel_posix, &raw) {
        convert_crlf_to_lf(raw)
    } else {
        (raw, false)
    };

    let mode = resolve_target_mode(rel_posix, &bytes, cached_remote_mode);

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha256 = hex::encode(hasher.finalize());

    Ok(PreparedSyncFile {
        rel_posix: rel_posix.to_string(),
        bytes,
        sha256,
        mode,
        mtime,
        crlf_converted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_crlf_and_preserves_exec_modes() {
        let script = b"#!/usr/bin/env bash\r\necho hello\r\n".to_vec();
        assert!(should_convert_crlf("tools/run", &script));
        let (clean, changed) = convert_crlf_to_lf(script);
        assert!(changed);
        assert_eq!(clean, b"#!/usr/bin/env bash\necho hello\n");
        assert_eq!(resolve_target_mode("tools/run", &clean, None), 0o755);

        assert!(should_convert_crlf("Makefile", b"all:\r\n\tgcc main.c\r\n"));
        assert!(should_convert_crlf("arch/arm/Kconfig", b"config FOO\r\n"));
        assert!(should_convert_crlf("rules.mk", b"CFLAGS += -O2\r\n"));
        assert!(!should_convert_crlf("src/main.c", b"int main() {\r\n}\r\n"));

        // Cached remote mode with +x is preserved even on extensionless binary/script
        assert_eq!(
            resolve_target_mode("bin/custom_tool", b"ELF...", Some(0o755)),
            0o755
        );
        assert_eq!(
            resolve_target_mode("src/main.c", b"int main(){}", None),
            0o644
        );
    }
}
