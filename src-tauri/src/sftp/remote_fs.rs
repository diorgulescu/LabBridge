use std::sync::Arc;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType};

use crate::error::AppResult;
use crate::sftp::paths::{join_remote_path, normalize_remote_path, parent_remote_path};
use crate::sftp::session_pool::SftpManager;
use crate::sftp::types::{DirListing, EntryKind, FsEntry};

/// Resolves `~`, `~/...`, or `.` against the remote SFTP session, returning a strict POSIX `/` path.
pub async fn resolve_remote_dir_path(
    sftp: &SftpSession,
    raw_path: Option<&str>,
) -> Result<String, russh_sftp::client::error::Error> {
    let norm = normalize_remote_path(raw_path.unwrap_or(""));

    if norm == "." || norm == "~" {
        if let Ok(Some(expanded)) = sftp.expand_path("~").await {
            return Ok(normalize_remote_path(&expanded));
        }
        let canon = sftp.canonicalize(".").await?;
        return Ok(normalize_remote_path(&canon));
    }

    if let Some(rest) = norm.strip_prefix("~/") {
        if let Ok(Some(expanded)) = sftp.expand_path(&norm).await {
            return Ok(normalize_remote_path(&expanded));
        }
        let home = sftp.canonicalize(".").await?;
        return Ok(join_remote_path(&home, rest));
    }

    if !norm.starts_with('/') {
        if let Ok(canon) = sftp.canonicalize(&norm).await {
            return Ok(normalize_remote_path(&canon));
        }
    }

    Ok(norm)
}

pub async fn remote_list_dir(
    sftp_manager: &SftpManager,
    profile_id: &str,
    path: Option<&str>,
) -> AppResult<DirListing> {
    sftp_manager
        .with_sftp(profile_id, |sftp| async move {
            let dir_path = resolve_remote_dir_path(&sftp, path).await?;
            let read_dir = sftp.read_dir(&dir_path).await?;

            let mut entries = Vec::new();
            for item in read_dir {
                let name = item.file_name();
                if name.is_empty()
                    || name == "."
                    || name == ".."
                    || name.starts_with(".labbridge.tmp.")
                {
                    continue;
                }

                let full_path = join_remote_path(&dir_path, &name);
                let meta = item.metadata();
                let ft = meta.file_type();

                let mut is_dir_like = ft == FileType::Dir;
                let mut size = meta.size.unwrap_or(0);

                let kind = match ft {
                    FileType::Dir => EntryKind::Dir,
                    FileType::File => EntryKind::File,
                    FileType::Symlink => {
                        if let Ok(target_meta) = sftp.metadata(&full_path).await {
                            is_dir_like = target_meta.is_dir();
                            if !is_dir_like {
                                size = target_meta.size.unwrap_or(size);
                            } else {
                                size = 0;
                            }
                        }
                        EntryKind::Symlink
                    }
                    FileType::Other => EntryKind::Other,
                };

                if kind == EntryKind::Dir {
                    size = 0;
                }

                let mode_bits = meta.permissions.map(|p| p & 0o7777);
                let permissions_octal = mode_bits.map(|m| format!("{:04o}", m));
                let permissions_rwx = meta.permissions.map(|_| meta.permissions().to_string());
                let is_executable =
                    kind != EntryKind::Dir && mode_bits.map_or(false, |m| (m & 0o111) != 0);
                let mtime = meta.mtime.map(|t| t as u64);

                entries.push(FsEntry {
                    name,
                    path: full_path,
                    kind,
                    is_dir_like,
                    size,
                    mtime,
                    permissions_octal,
                    permissions_rwx,
                    mode: mode_bits,
                    is_executable,
                });
            }

            Ok(DirListing {
                parent_path: parent_remote_path(&dir_path),
                path: dir_path,
                entries,
            })
        })
        .await
}

/// Ensures an absolute POSIX directory hierarchy exists on the remote SFTP server.
pub async fn ensure_remote_dir_all(
    sftp: &SftpSession,
    remote_dir: &str,
) -> Result<(), russh_sftp::client::error::Error> {
    let norm = normalize_remote_path(remote_dir);
    if norm == "/" || norm == "." {
        return Ok(());
    }

    if sftp.try_exists(&norm).await.unwrap_or(false) {
        return Ok(());
    }

    let mut ancestors: Vec<String> = Vec::new();
    let mut cursor = Some(norm);
    while let Some(curr) = cursor {
        if curr == "/" || curr == "." {
            break;
        }
        if sftp.try_exists(&curr).await.unwrap_or(false) {
            break;
        }
        cursor = parent_remote_path(&curr);
        ancestors.push(curr);
    }

    for dir in ancestors.into_iter().rev() {
        if !sftp.try_exists(&dir).await.unwrap_or(false) {
            sftp.create_dir(&dir).await?;
        }
    }
    Ok(())
}

pub async fn remote_create_dir(
    sftp_manager: &SftpManager,
    profile_id: &str,
    path: &str,
) -> AppResult<()> {
    let norm = normalize_remote_path(path);
    sftp_manager
        .with_sftp(profile_id, |sftp| {
            let target = norm.clone();
            async move { ensure_remote_dir_all(&sftp, &target).await }
        })
        .await
}

pub async fn remote_rename(
    sftp_manager: &SftpManager,
    profile_id: &str,
    old_path: &str,
    new_path: &str,
) -> AppResult<()> {
    let old_norm = normalize_remote_path(old_path);
    let new_norm = normalize_remote_path(new_path);
    sftp_manager
        .with_sftp(profile_id, |sftp| {
            let o = old_norm.clone();
            let n = new_norm.clone();
            async move { sftp.rename(o, n).await }
        })
        .await
}

pub async fn remote_delete(
    sftp_manager: &SftpManager,
    profile_id: &str,
    path: &str,
    recursive: bool,
) -> AppResult<()> {
    let norm = normalize_remote_path(path);
    sftp_manager
        .with_sftp(profile_id, |sftp| {
            let target = norm.clone();
            async move { delete_remote_entry_impl(&sftp, &target, recursive).await }
        })
        .await
}

async fn delete_remote_entry_impl(
    sftp: &Arc<SftpSession>,
    target: &str,
    recursive: bool,
) -> Result<(), russh_sftp::client::error::Error> {
    let sym_meta = sftp.symlink_metadata(target).await?;
    if sym_meta.file_type() != FileType::Dir {
        return sftp.remove_file(target).await;
    }

    if !recursive {
        return sftp.remove_dir(target).await;
    }

    // Iterative traversal to remove nested files first and directories bottom-up
    let mut dirs_to_visit = vec![target.to_string()];
    let mut dirs_post_order = Vec::new();

    while let Some(dir) = dirs_to_visit.pop() {
        let listing = sftp.read_dir(&dir).await?;
        for entry in listing {
            let child_name = entry.file_name();
            if child_name.is_empty() || child_name == "." || child_name == ".." {
                continue;
            }
            let child_path = join_remote_path(&dir, &child_name);
            if entry.file_type() == FileType::Dir {
                dirs_to_visit.push(child_path);
            } else {
                sftp.remove_file(&child_path).await?;
            }
        }
        dirs_post_order.push(dir);
    }

    for dir in dirs_post_order.into_iter().rev() {
        sftp.remove_dir(&dir).await?;
    }

    Ok(())
}

pub async fn remote_chmod(
    sftp_manager: &SftpManager,
    profile_id: &str,
    path: &str,
    mode: u32,
) -> AppResult<()> {
    let norm = normalize_remote_path(path);
    let masked = mode & 0o7777;
    sftp_manager
        .with_sftp(profile_id, |sftp| {
            let target = norm.clone();
            async move {
                let mut attrs = FileAttributes::empty();
                attrs.permissions = Some(masked);
                sftp.set_metadata(target, attrs).await
            }
        })
        .await
}
