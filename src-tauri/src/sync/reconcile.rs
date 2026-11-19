use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use rayon::prelude::*;

use crate::config::WorkspaceProfile;
use crate::error::{AppError, AppResult};
use crate::sftp::local_fs::resolve_local_path;
use crate::sftp::paths::{normalize_remote_path, shell_escape_posix};
use crate::sftp::SftpManager;
use crate::ssh::SshManager;
use crate::sync::filter::{walk_syncable_files, ProjectFilter, TEMP_FILE_PREFIX};
use crate::sync::sanitizer::{
    prepare_file_for_sync, resolve_target_mode, PreparedSyncFile, RemoteModeCache,
};
use crate::sync::types::{ReconcileReport, SyncStrategy};
use crate::sync::uploader::{execute_hybrid_batch, run_ssh_exec_checked};

const SPLIT_SENTINEL: &str = "__LABBRIDGE_SHA256_SPLIT__";

pub struct ReconcileExecutionResult {
    pub report: ReconcileReport,
    pub uploaded_files: Vec<String>,
    pub deleted_files: Vec<String>,
    pub crlf_converted_count: usize,
    pub strategy_used: Option<SyncStrategy>,
    pub bytes_transferred: u64,
}

/// Performs fast initial or manual workspace reconciliation:
/// 1. Runs `find . ... -exec sha256sum {} +` (and `stat` for POSIX modes) over SSH `exec` on Linux.
/// 2. Computes local SHA-256 hashes in parallel via `rayon` (accounting for active CRLF->LF policy).
/// 3. Batch-uploads ONLY missing or mismatched files via compressed `tar.gz` stream (unless `dry_run` is true).
pub async fn reconcile_workspace_impl(
    ssh_manager: &SshManager,
    sftp_manager: &SftpManager,
    mode_cache: &Arc<RemoteModeCache>,
    profile: &WorkspaceProfile,
    dry_run: bool,
) -> AppResult<ReconcileExecutionResult> {
    let started = Instant::now();

    if profile.local_root_path.trim().is_empty() || profile.remote_root_path.trim().is_empty() {
        return Err(AppError::Sync(
            "Both Local Root Path and Remote Root Path must be configured on the profile to reconcile.".into(),
        ));
    }

    let local_root = resolve_local_path(Some(&profile.local_root_path))?;
    if !local_root.is_dir() {
        return Err(AppError::Sync(format!(
            "Local root directory does not exist: {}",
            local_root.display()
        )));
    }

    let remote_root = normalize_remote_path(&profile.remote_root_path);
    let excluded_dirs = profile.excluded_dirs.clone();
    let crlf_guard = profile.crlf_guard_enabled;

    let local_root_bg = local_root.clone();
    let excluded_bg = excluded_dirs.clone();

    let local_scan_fut = tokio::task::spawn_blocking(move || {
        scan_and_hash_local_parallel(&local_root_bg, &excluded_bg, crlf_guard)
    });

    let remote_scan_fut = scan_remote_tree_over_exec(
        ssh_manager,
        &profile.id,
        &remote_root,
        &excluded_dirs,
    );

    let (local_join_res, remote_res) = tokio::join!(local_scan_fut, remote_scan_fut);

    let mut local_files = local_join_res
        .map_err(|e| AppError::Sync(format!("Local parallel hash worker failed: {}", e)))??;
    let (remote_hashes, remote_modes) = remote_res?;

    // Populate in-memory POSIX mode cache from remote scan
    mode_cache.replace_all(remote_modes);

    // Re-evaluate target POSIX modes now that RemoteModeCache holds live remote execute bits
    for f in &mut local_files {
        f.mode = resolve_target_mode(&f.rel_posix, &f.bytes, mode_cache.get(&f.rel_posix));
    }

    let project_filter = ProjectFilter::build(&local_root, &excluded_dirs)?;

    let mut local_seen = std::collections::HashSet::with_capacity(local_files.len());
    let mut missing_on_remote = Vec::new();
    let mut modified_files = Vec::new();
    let mut to_upload: Vec<PreparedSyncFile> = Vec::new();
    let mut identical_count = 0usize;

    for file in local_files {
        local_seen.insert(file.rel_posix.clone());
        match remote_hashes.get(&file.rel_posix) {
            None => {
                missing_on_remote.push(file.rel_posix.clone());
                to_upload.push(file);
            }
            Some(rem_sha) if !rem_sha.eq_ignore_ascii_case(&file.sha256) => {
                modified_files.push(file.rel_posix.clone());
                to_upload.push(file);
            }
            Some(_) => {
                identical_count += 1;
            }
        }
    }

    let mut remote_only_files: Vec<String> = remote_hashes
        .keys()
        .filter(|rem_rel| {
            !local_seen.contains(*rem_rel)
                && !project_filter.is_excluded_rel_posix(rem_rel, false)
        })
        .cloned()
        .collect();

    missing_on_remote.sort();
    modified_files.sort();
    remote_only_files.sort();

    let total_upload_bytes: u64 = to_upload.iter().map(|f| f.bytes.len() as u64).sum();
    let crlf_converted_count = to_upload.iter().filter(|f| f.crlf_converted).count();

    let mut uploaded_files: Vec<String> = to_upload.iter().map(|f| f.rel_posix.clone()).collect();
    uploaded_files.sort();

    let mut strategy_used = None;
    let mut bytes_transferred = 0u64;
    let mut deleted_files = Vec::new();

    if !dry_run {
        let deletions_to_apply: &[String] = if profile.sync_deletions {
            &remote_only_files
        } else {
            &[]
        };

        if !to_upload.is_empty() || !deletions_to_apply.is_empty() {
            let outcome = execute_hybrid_batch(
                ssh_manager,
                sftp_manager,
                mode_cache,
                &profile.id,
                &remote_root,
                to_upload,
                deletions_to_apply,
                profile.sync_deletions,
                true, // Force tar.gz stream path for reconciliation batches
            )
            .await?;

            strategy_used = Some(outcome.strategy);
            bytes_transferred = outcome.bytes_transferred;
            deleted_files = deletions_to_apply.to_vec();
        }
    }

    let duration_ms = started.elapsed().as_millis() as u64;

    Ok(ReconcileExecutionResult {
        report: ReconcileReport {
            profile_id: profile.id.clone(),
            dry_run,
            missing_on_remote,
            modified_files,
            remote_only_files,
            identical_count,
            total_upload_bytes,
            duration_ms,
        },
        uploaded_files,
        deleted_files,
        crlf_converted_count,
        strategy_used,
        bytes_transferred,
    })
}

fn scan_and_hash_local_parallel(
    local_root: &Path,
    excluded_dirs: &[String],
    crlf_guard_enabled: bool,
) -> AppResult<Vec<PreparedSyncFile>> {
    let entries = walk_syncable_files(local_root, excluded_dirs)?;

    let prepared: Vec<PreparedSyncFile> = entries
        .into_par_iter()
        .filter_map(|(abs_path, rel_posix)| {
            prepare_file_for_sync(&abs_path, &rel_posix, crlf_guard_enabled, None).ok()
        })
        .collect();

    Ok(prepared)
}

async fn scan_remote_tree_over_exec(
    ssh_manager: &SshManager,
    profile_id: &str,
    remote_root: &str,
    excluded_dirs: &[String],
) -> AppResult<(HashMap<String, String>, HashMap<String, u32>)> {
    let mut prune_names = vec![shell_escape_posix(".git")];
    for dir in excluded_dirs {
        let trimmed = dir.trim().trim_matches(|c| c == '/' || c == '\\');
        if !trimmed.is_empty() && trimmed != ".git" {
            prune_names.push(shell_escape_posix(trimmed));
        }
    }
    let prune_expr = prune_names
        .into_iter()
        .map(|n| format!("-name {}", n))
        .collect::<Vec<_>>()
        .join(" -o ");

    let escaped_root = shell_escape_posix(remote_root);
    let escaped_tmp_glob = shell_escape_posix(&format!("{}*", TEMP_FILE_PREFIX));

    let script = format!(
        "mkdir -p -- {root} && cd -- {root} && \
         find . \\( {prune} \\) -prune -o -type f ! -name {tmp} -exec stat -c '%a %n' {{}} + 2>/dev/null; \
         printf '\\n{sentinel}\\n'; \
         find . \\( {prune} \\) -prune -o -type f ! -name {tmp} -exec sha256sum {{}} +",
        root = escaped_root,
        prune = prune_expr,
        tmp = escaped_tmp_glob,
        sentinel = SPLIT_SENTINEL,
    );

    let output = run_ssh_exec_checked(ssh_manager, profile_id, &script, None).await?;
    Ok(parse_remote_scan_output(&output))
}

fn parse_remote_scan_output(raw: &str) -> (HashMap<String, String>, HashMap<String, u32>) {
    let mut hashes = HashMap::new();
    let mut modes = HashMap::new();

    let (modes_part, hashes_part) = match raw.split_once(SPLIT_SENTINEL) {
        Some((m, h)) => (m, h),
        None => ("", raw),
    };

    for line in modes_part.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some((octal_str, path_part)) = trimmed.split_once(' ') {
            if let Ok(mode) = u32::from_str_radix(octal_str.trim(), 8) {
                if let Some(rel) = clean_find_rel_path(path_part) {
                    modes.insert(rel, mode & 0o7777);
                }
            }
        }
    }

    for line in hashes_part.lines() {
        let trimmed = line.trim();
        if trimmed.len() < 66 {
            continue;
        }
        let digest = &trimmed[..64];
        if !digest.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let rest = &trimmed[64..];
        // sha256sum outputs either `  ./path` or ` *./path`
        let path_part = rest
            .strip_prefix("  ")
            .or_else(|| rest.strip_prefix(" *"))
            .unwrap_or_else(|| rest.trim_start());
        if let Some(rel) = clean_find_rel_path(path_part) {
            hashes.insert(rel, digest.to_ascii_lowercase());
        }
    }

    (hashes, modes)
}

fn clean_find_rel_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim().replace('\\', "/");
    let stripped = trimmed
        .strip_prefix("./")
        .unwrap_or(&trimmed)
        .trim_start_matches('/');
    if stripped.is_empty() || stripped.split('/').any(|s| s.starts_with(TEMP_FILE_PREFIX)) {
        None
    } else {
        Some(stripped.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_stat_and_sha256sum_output() {
        let sample = "\
755 ./scripts/deploy.sh
644 ./src/main.c
644 ./src/.labbridge.tmp.main.c

__LABBRIDGE_SHA256_SPLIT__
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  ./scripts/deploy.sh
a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3  ./src/main.c
ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  ./src/.labbridge.tmp.main.c
";
        let (hashes, modes) = parse_remote_scan_output(sample);
        assert_eq!(modes.get("scripts/deploy.sh"), Some(&0o755));
        assert_eq!(modes.get("src/main.c"), Some(&0o644));
        assert!(!modes.contains_key("src/.labbridge.tmp.main.c"));
        assert_eq!(hashes.len(), 2);
        assert!(hashes.contains_key("scripts/deploy.sh"));
        assert!(hashes.contains_key("src/main.c"));
    }
}
