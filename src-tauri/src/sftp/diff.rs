use std::time::Duration;

use russh::ChannelMsg;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::error::{AppError, AppResult};
use crate::sftp::local_fs::resolve_local_path;
use crate::sftp::paths::{normalize_remote_path, shell_escape_posix};
use crate::sftp::session_pool::SftpManager;
use crate::sftp::types::{DiffContentsResponse, FileHashComparison};
use crate::ssh::SshManager;

const DEFAULT_MAX_DIFF_BYTES: usize = 1024 * 1024; // 1 MiB safety cap for side-by-side DOM diff

pub async fn compare_file_hashes(
    ssh_manager: &SshManager,
    sftp_manager: &SftpManager,
    profile_id: &str,
    local_path: &str,
    remote_path: &str,
) -> AppResult<FileHashComparison> {
    let resolved_local = resolve_local_path(Some(local_path))?;
    let remote_norm = normalize_remote_path(remote_path);

    let (local_res, remote_res) = tokio::join!(
        compute_local_sha256(&resolved_local),
        compute_remote_sha256_via_exec(ssh_manager, profile_id, &remote_norm)
    );

    let (local_sha256, local_size) = local_res?;
    let remote_sha256 = remote_res?;

    let remote_size = sftp_manager
        .with_sftp(profile_id, |sftp| {
            let p = remote_norm.clone();
            async move { sftp.metadata(p).await.map(|m| m.size.unwrap_or(0)) }
        })
        .await
        .ok();

    let matches = local_sha256.eq_ignore_ascii_case(&remote_sha256);

    Ok(FileHashComparison {
        local_path: resolved_local.to_string_lossy().into_owned(),
        remote_path: remote_norm,
        local_sha256,
        remote_sha256,
        local_size,
        remote_size,
        matches,
    })
}

async fn compute_local_sha256(path: &std::path::Path) -> AppResult<(String, u64)> {
    let mut file = tokio::fs::File::open(path).await.map_err(|e| {
        AppError::Io(std::io::Error::new(
            e.kind(),
            format!("Cannot open local file '{}': {}", path.display(), e),
        ))
    })?;

    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 65_536];
    let mut total_bytes: u64 = 0;

    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total_bytes += n as u64;
    }

    let digest = hex::encode(hasher.finalize());
    Ok((digest, total_bytes))
}

async fn compute_remote_sha256_via_exec(
    ssh_manager: &SshManager,
    profile_id: &str,
    remote_posix_path: &str,
) -> AppResult<String> {
    let handle = ssh_manager.get_handle(profile_id).await?;
    let mut channel = handle.channel_open_session().await?;

    let escaped = shell_escape_posix(remote_posix_path);
    let command = format!(
        "sha256sum -- {p} 2>/dev/null || shasum -a 256 -- {p}",
        p = escaped
    );

    channel.exec(true, command.into_bytes()).await?;

    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();
    let mut exit_code: Option<u32> = None;

    let collect = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => stdout_buf.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, .. } => stderr_buf.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
    };

    tokio::time::timeout(Duration::from_secs(30), collect)
        .await
        .map_err(|_| AppError::Ssh("Timed out computing remote sha256sum".into()))?;

    let stdout_str = String::from_utf8_lossy(&stdout_buf);
    if let Some(token) = stdout_str.split_whitespace().next() {
        if token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(token.to_ascii_lowercase());
        }
    }

    let stderr_str = String::from_utf8_lossy(&stderr_buf).trim().to_string();
    Err(AppError::Sftp(format!(
        "Failed to compute remote sha256sum for '{}' (exit {:?}): {}",
        remote_posix_path,
        exit_code,
        if stderr_str.is_empty() {
            stdout_str.trim()
        } else {
            &stderr_str
        }
    )))
}

pub async fn read_diff_contents(
    sftp_manager: &SftpManager,
    profile_id: &str,
    local_path: &str,
    remote_path: &str,
    max_bytes: Option<usize>,
) -> AppResult<DiffContentsResponse> {
    let limit = max_bytes.unwrap_or(DEFAULT_MAX_DIFF_BYTES).clamp(4096, 4 * 1024 * 1024);
    let resolved_local = resolve_local_path(Some(local_path))?;
    let remote_norm = normalize_remote_path(remote_path);

    let mut local_file = tokio::fs::File::open(&resolved_local).await?;
    let mut local_bytes = Vec::new();
    let mut local_reader = (&mut local_file).take((limit + 1) as u64);
    local_reader.read_to_end(&mut local_bytes).await?;

    let remote_bytes = sftp_manager
        .with_sftp(profile_id, |sftp| {
            let p = remote_norm.clone();
            async move {
                let mut file = sftp.open(p).await?;
                let mut out = Vec::new();
                let mut bounded = (&mut file).take((limit + 1) as u64);
                bounded.read_to_end(&mut out).await?;
                Ok(out)
            }
        })
        .await?;

    let mut truncated = false;
    if local_bytes.len() > limit {
        local_bytes.truncate(limit);
        truncated = true;
    }
    if remote_bytes.len() > limit {
        truncated = true;
    }
    let remote_slice = if remote_bytes.len() > limit {
        &remote_bytes[..limit]
    } else {
        &remote_bytes[..]
    };

    let check_len_local = local_bytes.len().min(8192);
    let check_len_remote = remote_slice.len().min(8192);
    let is_binary = local_bytes[..check_len_local].contains(&0)
        || remote_slice[..check_len_remote].contains(&0);

    let (local_text, remote_text) = if is_binary {
        (String::new(), String::new())
    } else {
        (
            String::from_utf8_lossy(&local_bytes).replace("\r\n", "\n"),
            String::from_utf8_lossy(remote_slice).replace("\r\n", "\n"),
        )
    };

    Ok(DiffContentsResponse {
        local_path: resolved_local.to_string_lossy().into_owned(),
        remote_path: remote_norm,
        local_text,
        remote_text,
        is_binary,
        truncated,
    })
}
