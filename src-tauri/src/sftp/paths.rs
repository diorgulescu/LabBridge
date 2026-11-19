/// Strict POSIX `/` path utilities for remote Linux SFTP and SSH exec operations,
/// ensuring Windows `\` separators never leak onto the wire regardless of host OS.

/// Normalizes any path string into a clean POSIX `/` path.
/// - Converts all `\` into `/`.
/// - Collapses duplicate slashes.
/// - Resolves `.` and `..` segments cleanly for absolute paths.
pub fn normalize_remote_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return ".".to_string();
    }

    let unified = trimmed.replace('\\', "/");

    // Preserve `~` or `~/...` prefix for home expansion before canonicalize
    if unified == "~" {
        return "~".to_string();
    }
    if let Some(rest) = unified.strip_prefix("~/") {
        let mut stack: Vec<&str> = Vec::new();
        for part in rest.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    stack.pop();
                }
                seg => stack.push(seg),
            }
        }
        if stack.is_empty() {
            return "~".to_string();
        }
        return format!("~/{}", stack.join("/"));
    }

    let is_abs = unified.starts_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for part in unified.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if !stack.is_empty() && stack.last() != Some(&"..") {
                    stack.pop();
                } else if !is_abs {
                    stack.push("..");
                }
            }
            seg => stack.push(seg),
        }
    }

    if is_abs {
        if stack.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", stack.join("/"))
        }
    } else if stack.is_empty() {
        ".".to_string()
    } else {
        stack.join("/")
    }
}

/// Joins a base remote directory and a relative child path using strict POSIX `/` separators.
pub fn join_remote_path(base: &str, child: &str) -> String {
    let child_clean = child.trim().replace('\\', "/");
    if child_clean.starts_with('/') || child_clean == "~" || child_clean.starts_with("~/") {
        return normalize_remote_path(&child_clean);
    }

    let base_norm = normalize_remote_path(base);
    let combined = if base_norm == "/" {
        format!("/{}", child_clean)
    } else if base_norm == "." {
        child_clean
    } else {
        format!("{}/{}", base_norm, child_clean)
    };
    normalize_remote_path(&combined)
}

/// Computes the parent directory of an absolute POSIX remote path.
pub fn parent_remote_path(path: &str) -> Option<String> {
    let norm = normalize_remote_path(path);
    if norm == "/" || norm == "." || norm == "~" {
        return None;
    }
    if let Some(idx) = norm.rfind('/') {
        if idx == 0 {
            Some("/".to_string())
        } else {
            Some(norm[..idx].to_string())
        }
    } else {
        None
    }
}

/// Extracts the final file/directory name component from a POSIX remote path.
pub fn remote_file_name(path: &str) -> String {
    let norm = normalize_remote_path(path);
    if norm == "/" {
        return "/".to_string();
    }
    norm.rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(&norm)
        .to_string()
}

/// Safely quotes a POSIX path for execution in an SSH `exec` command (`'...'`).
pub fn shell_escape_posix(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_joins_strict_posix_paths() {
        assert_eq!(
            normalize_remote_path(r"\var\log\\nginx\..\syslog\"),
            "/var/log/syslog"
        );
        assert_eq!(normalize_remote_path("/"), "/");
        assert_eq!(
            join_remote_path(r"\home\ubuntu\", r"build\bin\app"),
            "/home/ubuntu/build/bin/app"
        );
        assert_eq!(join_remote_path("/", "etc"), "/etc");
        assert_eq!(parent_remote_path("/home/ubuntu"), Some("/home".into()));
        assert_eq!(parent_remote_path("/home"), Some("/".into()));
        assert_eq!(parent_remote_path("/"), None);
        assert_eq!(
            shell_escape_posix("/home/u/.labbridge.tmp.my'file $(id)`x`.sh"),
            "'/home/u/.labbridge.tmp.my'\\''file $(id)`x`.sh'"
        );
    }
}
