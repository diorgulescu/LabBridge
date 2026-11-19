use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use flate2::write::GzEncoder;
use flate2::Compression;
use russh::ChannelMsg;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::FileAttributes;
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, AppResult};
use crate::sftp::paths::{
    join_remote_path, normalize_remote_path, parent_remote_path, remote_file_name,
    shell_escape_posix,
};
use crate::sftp::remote_fs::ensure_remote_dir_all;
use crate::sftp::SftpManager;
use crate::ssh::SshManager;
use crate::sync::filter::TEMP_FILE_PREFIX;
use crate::sync::sanitizer::{PreparedSyncFile, RemoteModeCache};
use crate::sync::types::SyncStrategy;

const FAST_PATH_MAX_FILES: usize = 3;
const FAST_PATH_MAX_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB

pub struct BatchUploadOutcome {
    pub strategy: SyncStrategy,
    pub bytes_transferred: u64,
}

pub fn select_upload_strategy(
    files: &[PreparedSyncFile],
    force_tar_stream: bool,
) -> SyncStrategy {
    if files.is_empty() {
        return SyncStrategy::ExecDelete;
    }
    if force_tar_stream || files.len() > FAST_PATH_MAX_FILES {
        return SyncStrategy::TarStream;
    }
    let total_bytes: u64 = files.iter().map(|f| f.bytes.len() as u64).sum();
    if total_bytes >= FAST_PATH_MAX_BYTES {
        SyncStrategy::TarStream
    } else {
        SyncStrategy::SftpAtomic
    }
}

/// Executes a sync batch using either the Fast SFTP Atomic Path (1-3 files < 2 MB)
/// or the Compressed TAR.GZ Stream Path (4+ files, >= 2 MB, or workspace reconciliation),
/// plus optional batched `rm -f` deletions when `sync_deletions` is enabled.
pub async fn execute_hybrid_batch(
    ssh_manager: &SshManager,
    sftp_manager: &SftpManager,
    mode_cache: &Arc<RemoteModeCache>,
    profile_id: &str,
    remote_root_raw: &str,
    files: Vec<PreparedSyncFile>,
    deletions_rel_posix: &[String],
    sync_deletions: bool,
    force_tar_stream: bool,
) -> AppResult<BatchUploadOutcome> {
    let remote_root = normalize_remote_path(remote_root_raw);
    let strategy = select_upload_strategy(&files, force_tar_stream);

    let bytes_transferred = if !files.is_empty() {
        match strategy {
            SyncStrategy::SftpAtomic => {
                upload_fast_sftp_atomic(
                    ssh_manager,
                    sftp_manager,
                    mode_cache,
                    profile_id,
                    &remote_root,
                    &files,
                )
                .await?
            }
            SyncStrategy::TarStream | SyncStrategy::ExecDelete => {
                upload_tar_gz_stream(ssh_manager, mode_cache, profile_id, &remote_root, files)
                    .await?
            }
        }
    } else {
        0
    };

    if sync_deletions && !deletions_rel_posix.is_empty() {
        delete_remote_files_batched(
            ssh_manager,
            mode_cache,
            profile_id,
            &remote_root,
            deletions_rel_posix,
        )
        .await?;
    }

    Ok(BatchUploadOutcome {
        strategy,
        bytes_transferred,
    })
}

async fn upload_fast_sftp_atomic(
    ssh_manager: &SshManager,
    sftp_manager: &SftpManager,
    mode_cache: &Arc<RemoteModeCache>,
    profile_id: &str,
    remote_root: &str,
    files: &[PreparedSyncFile],
) -> AppResult<u64> {
    let _span = tracing::info_span!(
        "sync_sftp_atomic",
        profile_id,
        file_count = files.len(),
        remote_root,
    );
    let _guard = _span.enter();

    let sftp = sftp_manager.get_or_create(profile_id).await?;

    // Ensure unique parent directories exist first
    let mut ensured_parents = std::collections::HashSet::new();
    for f in files {
        let final_remote = join_remote_path(remote_root, &f.rel_posix);
        if let Some(parent) = parent_remote_path(&final_remote) {
            if ensured_parents.insert(parent.clone()) {
                if ensure_remote_dir_all(&sftp, &parent).await.is_err() {
                    sftp_manager.invalidate(profile_id).await;
                    let fresh = sftp_manager.get_or_create(profile_id).await?;
                    ensure_remote_dir_all(&fresh, &parent).await?;
                }
            }
        }
    }

    let sftp = sftp_manager.get_or_create(profile_id).await?;

    // Concurrently write `.labbridge.tmp.<name>` and set POSIX mode on all 1..=3 files
    let mut tasks = tokio::task::JoinSet::new();
    for file in files.iter().cloned() {
        let sftp_clone = Arc::clone(&sftp);
        let root_owned = remote_root.to_string();
        tasks.spawn(async move {
            let final_remote = join_remote_path(&root_owned, &file.rel_posix);
            let parent = parent_remote_path(&final_remote).unwrap_or_else(|| root_owned.clone());
            let base_name = remote_file_name(&final_remote);
            let tmp_name = format!("{}{}", TEMP_FILE_PREFIX, base_name);
            let tmp_remote = join_remote_path(&parent, &tmp_name);

            let mut remote_handle = sftp_clone.create(&tmp_remote).await?;
            if let Err(io_err) = remote_handle.write_all(&file.bytes).await {
                let _ = sftp_clone.remove_file(&tmp_remote).await;
                return Err(AppError::Io(io_err));
            }
            if let Err(io_err) = remote_handle.shutdown().await {
                let _ = sftp_clone.remove_file(&tmp_remote).await;
                return Err(AppError::Io(io_err));
            }

            let mut attrs = FileAttributes::empty();
            attrs.permissions = Some(file.mode & 0o7777);
            if let Err(chmod_err) = sftp_clone.set_metadata(&tmp_remote, attrs).await {
                let _ = sftp_clone.remove_file(&tmp_remote).await;
                return Err(AppError::from(chmod_err));
            }

            // Attempt direct SFTP rename first; if destination exists on OpenSSH SFTP v3,
            // fall back to atomic POSIX `mv -f` via SSH exec so target is never unlinked mid-read.
            let needs_exec_mv = match sftp_clone.rename(&tmp_remote, &final_remote).await {
                Ok(()) => false,
                Err(SftpError::Status(_)) => true,
                Err(other) => {
                    let _ = sftp_clone.remove_file(&tmp_remote).await;
                    return Err(AppError::from(other));
                }
            };

            Ok::<(String, String, String, u32, u64, bool), AppError>((
                file.rel_posix,
                tmp_remote,
                final_remote,
                file.mode,
                file.bytes.len() as u64,
                needs_exec_mv,
            ))
        });
    }

    let mut total_bytes = 0u64;
    let mut pending_atomic_mvs: Vec<(String, String)> = Vec::new();
    let mut completed_modes: Vec<(String, u32)> = Vec::new();

    while let Some(joined) = tasks.join_next().await {
        let (rel_posix, tmp_remote, final_remote, mode, len, needs_mv) = joined
            .map_err(|e| AppError::Sync(format!("Concurrent SFTP task panicked: {}", e)))??;
        total_bytes += len;
        completed_modes.push((rel_posix, mode));
        if needs_mv {
            pending_atomic_mvs.push((tmp_remote, final_remote));
        }
    }

    if !pending_atomic_mvs.is_empty() {
        let mv_cmds: Vec<String> = pending_atomic_mvs
            .iter()
            .map(|(tmp, dst)| {
                format!(
                    "mv -f -- {} {}",
                    shell_escape_posix(tmp),
                    shell_escape_posix(dst)
                )
            })
            .collect();
        let script = mv_cmds.join(" && ");
        if let Err(err) = run_ssh_exec_checked(ssh_manager, profile_id, &script, None).await {
            // Clean up any leftover temp files if mv failed
            for (tmp, _) in &pending_atomic_mvs {
                let _ = sftp.remove_file(tmp).await;
            }
            return Err(err);
        }
    }

    for (rel_posix, mode) in completed_modes {
        mode_cache.set(rel_posix, mode);
    }

    Ok(total_bytes)
}

async fn upload_tar_gz_stream(
    ssh_manager: &SshManager,
    mode_cache: &Arc<RemoteModeCache>,
    profile_id: &str,
    remote_root: &str,
    files: Vec<PreparedSyncFile>,
) -> AppResult<u64> {
    let _span = tracing::info_span!(
        "sync_tar_stream",
        profile_id,
        file_count = files.len(),
        remote_root,
    );
    let _guard = _span.enter();

    let modes_to_record: Vec<(String, u32)> = files
        .iter()
        .map(|f| (f.rel_posix.clone(), f.mode))
        .collect();

    let compressed_archive = tokio::task::spawn_blocking(move || build_tar_gz_bytes(&files))
        .await
        .map_err(|e| AppError::Sync(format!("TAR builder join error: {}", e)))??;

    let archive_len = compressed_archive.len() as u64;
    let escaped_root = shell_escape_posix(remote_root);
    let cmd = format!("mkdir -p -- {r} && tar -xzf - -C {r}", r = escaped_root);

    run_ssh_exec_checked(ssh_manager, profile_id, &cmd, Some(&compressed_archive)).await?;

    for (rel_posix, mode) in modes_to_record {
        mode_cache.set(rel_posix, mode);
    }

    Ok(archive_len)
}

pub fn build_tar_gz_bytes(files: &[PreparedSyncFile]) -> AppResult<Vec<u8>> {
    let gz = GzEncoder::new(Vec::new(), Compression::fast());
    let mut tar_builder = tar::Builder::new(gz);

    for file in files {
        let clean_rel = file
            .rel_posix
            .replace('\\', "/")
            .trim_start_matches('/')
            .to_string();
        if clean_rel.is_empty()
            || clean_rel.split('/').any(|s| s == ".." || s == ".git" || s.starts_with(TEMP_FILE_PREFIX))
        {
            continue;
        }

        let mut header = tar::Header::new_gnu();
        header.set_size(file.bytes.len() as u64);
        header.set_mode(file.mode & 0o7777);
        header.set_mtime(file.mtime);
        header.set_entry_type(tar::EntryType::Regular);
        header.set_cksum();

        tar_builder
            .append_data(&mut header, &clean_rel, &file.bytes[..])
            .map_err(|e| AppError::Sync(format!("Failed to append '{}' to tar: {}", clean_rel, e)))?;
    }

    let mut gz = tar_builder
        .into_inner()
        .map_err(|e| AppError::Sync(format!("Failed to finalize tar stream: {}", e)))?;
    gz.flush()?;
    let bytes = gz
        .finish()
        .map_err(|e| AppError::Sync(format!("Failed to finish gzip stream: {}", e)))?;
    Ok(bytes)
}

async fn delete_remote_files_batched(
    ssh_manager: &SshManager,
    mode_cache: &Arc<RemoteModeCache>,
    profile_id: &str,
    remote_root: &str,
    deletions_rel_posix: &[String],
) -> AppResult<()> {
    let safe_rels: Vec<&String> = deletions_rel_posix
        .iter()
        .filter(|r| {
            !r.is_empty()
                && !r
                    .split('/')
                    .any(|s| s == ".." || s == ".git" || s.starts_with(TEMP_FILE_PREFIX))
        })
        .collect();

    for chunk in safe_rels.chunks(80) {
        let escaped_args: Vec<String> = chunk
            .iter()
            .map(|rel| {
                let full = join_remote_path(remote_root, rel);
                shell_escape_posix(&full)
            })
            .collect();
        let cmd = format!("rm -f -- {}", escaped_args.join(" "));
        run_ssh_exec_checked(ssh_manager, profile_id, &cmd, None).await?;
    }

    for rel in safe_rels {
        mode_cache.remove(rel);
    }

    Ok(())
}

/// Runs a shell command over a multiplexed SSH `exec` channel, optionally streaming `stdin_payload`,
/// and verifies exit code `0`. Supports cooperative cancellation via `CancellationToken` so
/// long-running remote commands (e.g. large tar extractions) can be aborted from the frontend.
pub async fn run_ssh_exec_checked(
    ssh_manager: &SshManager,
    profile_id: &str,
    command: &str,
    stdin_payload: Option<&[u8]>,
) -> AppResult<String> {
    run_ssh_exec_checked_with_cancel(
        ssh_manager,
        profile_id,
        command,
        stdin_payload,
        None,
    )
    .await
}

/// Variant of [`run_ssh_exec_checked`] that accepts an optional [`CancellationToken`].
/// When the token is cancelled, the SSH channel is closed immediately and an error is returned.
pub async fn run_ssh_exec_checked_with_cancel(
    ssh_manager: &SshManager,
    profile_id: &str,
    command: &str,
    stdin_payload: Option<&[u8]>,
    cancel_token: Option<tokio_util::sync::CancellationToken>,
) -> AppResult<String> {
    let handle = ssh_manager.get_handle(profile_id).await?;
    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, command.as_bytes()).await?;

    if let Some(payload) = stdin_payload {
        let mut writer = channel.make_writer();
        for chunk in payload.chunks(65_536) {
            if let Some(ref tok) = cancel_token {
                if tok.is_cancelled() {
                    let _ = channel.close().await;
                    return Err(AppError::Sync("SSH exec cancelled".into()));
                }
            }
            writer.write_all(chunk).await?;
        }
        writer.flush().await?;
        channel.eof().await?;
    }

    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();
    let mut exit_code: Option<u32> = None;

    let collect = async {
        loop {
            tokio::select! {
                biased;
                _ = async {
                    if let Some(ref tok) = cancel_token {
                        tok.cancelled().await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => {
                    return Err(());
                }
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => stdout_buf.extend_from_slice(data),
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => stderr_buf.extend_from_slice(data),
                        Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
            }
        }
        Ok(())
    };

    let collect_result = tokio::time::timeout(Duration::from_secs(120), collect)
        .await
        .map_err(|_| AppError::Sync("SSH exec command timed out".into()))?;

    let _ = channel.close().await;

    if collect_result.is_err() {
        return Err(AppError::Sync("SSH exec cancelled".into()));
    }

    let stdout_str = String::from_utf8_lossy(&stdout_buf).into_owned();
    let stderr_str = String::from_utf8_lossy(&stderr_buf).trim().to_string();

    if exit_code.unwrap_or(0) != 0 {
        return Err(AppError::Sync(format!(
            "Remote command exited with {:?}: {}",
            exit_code,
            if stderr_str.is_empty() {
                stdout_str.trim()
            } else {
                &stderr_str
            }
        )));
    }

    Ok(stdout_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;

    #[test]
    fn builds_valid_posix_tar_gz_preserving_modes_and_skipping_temps() {
        let files = vec![
            PreparedSyncFile {
                rel_posix: "scripts/deploy.sh".into(),
                bytes: b"#!/bin/sh\necho ok\n".to_vec(),
                sha256: "abc".into(),
                mode: 0o755,
                mtime: 1_700_000_000,
                crlf_converted: true,
            },
            PreparedSyncFile {
                rel_posix: "src/.labbridge.tmp.main.c".into(),
                bytes: b"should-be-skipped".to_vec(),
                sha256: "def".into(),
                mode: 0o644,
                mtime: 1_700_000_000,
                crlf_converted: false,
            },
        ];

        let gz_bytes = build_tar_gz_bytes(&files).expect("build tar.gz");
        let decoder = GzDecoder::new(&gz_bytes[..]);
        let mut archive = tar::Archive::new(decoder);

        let mut seen = Vec::new();
        for entry_res in archive.entries().unwrap() {
            let mut entry = entry_res.unwrap();
            let path = entry.path().unwrap().to_string_lossy().into_owned();
            let mode = entry.header().mode().unwrap();
            let mut body = String::new();
            entry.read_to_string(&mut body).unwrap();
            seen.push((path, mode & 0o7777, body));
        }

        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "scripts/deploy.sh");
        assert_eq!(seen[0].1, 0o755);
        assert_eq!(seen[0].2, "#!/bin/sh\necho ok\n");
    }
}
