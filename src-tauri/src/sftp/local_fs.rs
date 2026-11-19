use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

use crate::error::{AppError, AppResult};
use crate::sftp::types::{DirListing, EntryKind, FsEntry};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn resolve_local_path(raw: Option<&str>) -> AppResult<PathBuf> {
    let trimmed = raw.map(str::trim).unwrap_or("");
    if trimmed.is_empty() || trimmed == "~" {
        return dirs::home_dir()
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| AppError::Io(std::io::Error::other("Cannot resolve home directory")));
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        if let Some(home) = dirs::home_dir() {
            return Ok(clean_windows_verbatim(home.join(rest)));
        }
    }
    Ok(clean_windows_verbatim(PathBuf::from(trimmed)))
}

fn clean_windows_verbatim(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

pub fn local_list_dir(path: Option<&str>) -> AppResult<DirListing> {
    let target = resolve_local_path(path)?;
    if !target.exists() {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("Local directory does not exist: {}", target.display()),
        )));
    }

    let resolved = fs::canonicalize(&target)
        .map(clean_windows_verbatim)
        .unwrap_or(target);

    let parent_path = resolved
        .parent()
        .filter(|p| !p.as_os_str().is_empty() && *p != resolved)
        .map(|p| p.to_string_lossy().into_owned());

    let read_dir = fs::read_dir(&resolved)?;
    let mut entries = Vec::new();

    for item in read_dir {
        let Ok(entry) = item else {
            continue;
        };
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() {
            continue;
        }

        let Ok(sym_meta) = fs::symlink_metadata(&entry_path) else {
            continue;
        };

        let file_type = sym_meta.file_type();
        let (kind, is_dir_like, size, mtime_meta) = if file_type.is_symlink() {
            match fs::metadata(&entry_path) {
                Ok(target_meta) => (
                    EntryKind::Symlink,
                    target_meta.is_dir(),
                    if target_meta.is_dir() {
                        0
                    } else {
                        target_meta.len()
                    },
                    target_meta,
                ),
                Err(_) => (EntryKind::Symlink, false, sym_meta.len(), sym_meta),
            }
        } else if file_type.is_dir() {
            (EntryKind::Dir, true, 0, sym_meta)
        } else if file_type.is_file() {
            let len = sym_meta.len();
            (EntryKind::File, false, len, sym_meta)
        } else {
            (EntryKind::Other, false, 0, sym_meta)
        };

        let mtime = mtime_meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        let is_executable = is_local_executable(&entry_path, &mtime_meta, kind);

        entries.push(FsEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            kind,
            is_dir_like,
            size,
            mtime,
            permissions_octal: None,
            permissions_rwx: None,
            mode: None,
            is_executable,
        });
    }

    Ok(DirListing {
        path: resolved.to_string_lossy().into_owned(),
        parent_path,
        entries,
    })
}

#[cfg(unix)]
fn is_local_executable(_path: &Path, meta: &fs::Metadata, kind: EntryKind) -> bool {
    use std::os::unix::fs::PermissionsExt;
    kind != EntryKind::Dir && (meta.permissions().mode() & 0o111) != 0
}

#[cfg(not(unix))]
fn is_local_executable(path: &Path, _meta: &fs::Metadata, kind: EntryKind) -> bool {
    if kind == EntryKind::Dir {
        return false;
    }
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("exe" | "bat" | "cmd" | "ps1" | "sh")
    )
}

pub fn local_create_dir(path: &str) -> AppResult<()> {
    let resolved = resolve_local_path(Some(path))?;
    fs::create_dir_all(resolved)?;
    Ok(())
}

pub fn local_rename(old_path: &str, new_path: &str) -> AppResult<()> {
    let old_resolved = resolve_local_path(Some(old_path))?;
    let new_resolved = resolve_local_path(Some(new_path))?;
    fs::rename(old_resolved, new_resolved)?;
    Ok(())
}

pub fn local_delete(path: &str) -> AppResult<()> {
    let resolved = resolve_local_path(Some(path))?;
    let sym_meta = fs::symlink_metadata(&resolved)?;
    let ft = sym_meta.file_type();

    if ft.is_symlink() {
        #[cfg(windows)]
        {
            // On Windows, directory symlinks/junctions may require remove_dir instead of remove_file
            if fs::remove_file(&resolved).is_err() {
                fs::remove_dir(&resolved)?;
            }
        }
        #[cfg(not(windows))]
        {
            fs::remove_file(&resolved)?;
        }
    } else if ft.is_dir() {
        fs::remove_dir_all(&resolved)?;
    } else {
        fs::remove_file(&resolved)?;
    }
    Ok(())
}

/// Spawns `code <local_path>` detached without flashing a console window on Windows (`CREATE_NO_WINDOW`).
pub fn open_in_vscode(local_path: &str) -> AppResult<()> {
    let target = resolve_local_path(Some(local_path))?;
    if !target.exists() {
        return Err(AppError::Config(format!(
            "Local path does not exist: {}",
            target.display()
        )));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        // 1. Prefer direct Code.exe binary if installed in standard user/system locations
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(local_app_data)
                    .join("Programs")
                    .join("Microsoft VS Code")
                    .join("Code.exe"),
            );
        }
        if let Some(prog_files) = std::env::var_os("ProgramFiles") {
            candidates.push(
                PathBuf::from(prog_files)
                    .join("Microsoft VS Code")
                    .join("Code.exe"),
            );
        }

        for exe in candidates {
            if exe.is_file() {
                if Command::new(&exe)
                    .arg(&target)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
                    .is_ok()
                {
                    return Ok(());
                }
            }
        }

        // 2. Spawn `code.cmd` / `cmd /C code <local_path>` on PATH with CREATE_NO_WINDOW
        if Command::new("code.cmd")
            .arg(&target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }

        Command::new("cmd")
            .args(["/C", "code"])
            .arg(&target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| {
                AppError::Io(std::io::Error::new(
                    e.kind(),
                    format!("Failed to launch VS Code (`code`): {}", e),
                ))
            })?;

        Ok(())
    }

    #[cfg(not(windows))]
    {
        if Command::new("code")
            .arg(&target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
        {
            return Ok(());
        }

        #[cfg(target_os = "macos")]
        {
            let mac_bin =
                Path::new("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
            if mac_bin.is_file()
                && Command::new(mac_bin)
                    .arg(&target)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .is_ok()
            {
                return Ok(());
            }
        }

        Err(AppError::Config(
            "Could not find `code` CLI in PATH. Install VS Code and enable the `code` command."
                .into(),
        ))
    }
}
