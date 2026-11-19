use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::sftp::local_fs::resolve_local_path;
use crate::sftp::paths::{
    join_remote_path, normalize_remote_path, parent_remote_path, remote_file_name,
};
use crate::sftp::remote_fs::ensure_remote_dir_all;
use crate::sftp::session_pool::{is_channel_dropped_error, SftpManager};
use crate::sftp::types::{TransferDirection, TransferProgressEvent, TransferStatus};

const CHUNK_SIZE: usize = 131_072; // 128 KiB streaming buffer
const PROGRESS_THROTTLE: Duration = Duration::from_millis(65);

struct QueuedJob {
    transfer_id: String,
    profile_id: String,
    direction: TransferDirection,
    root_name: String,
    source_path: String,
    dest_path: String,
    cancel_token: CancellationToken,
}

pub struct TransferManager {
    sftp_manager: Arc<SftpManager>,
    job_tx: mpsc::UnboundedSender<QueuedJob>,
    items: Arc<RwLock<Vec<TransferProgressEvent>>>,
    cancels: Arc<Mutex<HashMap<String, CancellationToken>>>,
    subscribers: Arc<Mutex<Vec<Channel<TransferProgressEvent>>>>,
}

impl TransferManager {
    pub fn new(sftp_manager: Arc<SftpManager>) -> Arc<Self> {
        let (job_tx, mut job_rx) = mpsc::unbounded_channel::<QueuedJob>();
        let items = Arc::new(RwLock::new(Vec::new()));
        let cancels = Arc::new(Mutex::new(HashMap::new()));
        let subscribers = Arc::new(Mutex::new(Vec::new()));

        let manager = Arc::new(Self {
            sftp_manager,
            job_tx,
            items,
            cancels,
            subscribers,
        });

        let worker_mgr = Arc::clone(&manager);
        tokio::spawn(async move {
            while let Some(job) = job_rx.recv().await {
                worker_mgr.process_job(job).await;
            }
        });

        manager
    }

    pub async fn subscribe(&self, channel: Channel<TransferProgressEvent>) -> AppResult<()> {
        // Replay existing transfer snapshot immediately to the newly subscribed channel
        let snapshot = self.items.read().await.clone();
        for ev in &snapshot {
            let _ = channel.send(ev.clone());
        }
        self.subscribers.lock().await.push(channel);
        Ok(())
    }

    pub async fn list_transfers(&self) -> Vec<TransferProgressEvent> {
        self.items.read().await.clone()
    }

    pub async fn clear_finished(&self) {
        let mut guard = self.items.write().await;
        guard.retain(|item| {
            matches!(
                item.status,
                TransferStatus::Queued | TransferStatus::InProgress
            )
        });
    }

    pub async fn enqueue_transfer(
        &self,
        profile_id: String,
        direction: TransferDirection,
        source_path: String,
        dest_path: String,
    ) -> AppResult<TransferProgressEvent> {
        let (norm_source, norm_dest, root_name) = match direction {
            TransferDirection::Upload => {
                let local = resolve_local_path(Some(&source_path))?;
                if !local.exists() {
                    return Err(AppError::Io(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        format!("Local source does not exist: {}", local.display()),
                    )));
                }
                let name = local
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "upload".to_string());
                let remote = normalize_remote_path(&dest_path);
                (local.to_string_lossy().into_owned(), remote, name)
            }
            TransferDirection::Download => {
                let remote = normalize_remote_path(&source_path);
                let local = resolve_local_path(Some(&dest_path))?;
                let name = remote_file_name(&remote);
                (remote, local.to_string_lossy().into_owned(), name)
            }
        };

        let transfer_id = Uuid::new_v4().to_string();
        let cancel_token = CancellationToken::new();

        self.cancels
            .lock()
            .await
            .insert(transfer_id.clone(), cancel_token.clone());

        let initial_event = TransferProgressEvent {
            transfer_id: transfer_id.clone(),
            profile_id: profile_id.clone(),
            direction,
            file_name: root_name.clone(),
            source_path: norm_source.clone(),
            dest_path: norm_dest.clone(),
            bytes_done: 0,
            bytes_total: 0,
            speed_bps: 0,
            status: TransferStatus::Queued,
            error: None,
        };

        {
            let mut guard = self.items.write().await;
            guard.insert(0, initial_event.clone());
        }
        self.broadcast(&initial_event).await;

        let _ = self.job_tx.send(QueuedJob {
            transfer_id,
            profile_id,
            direction,
            root_name,
            source_path: norm_source,
            dest_path: norm_dest,
            cancel_token,
        });

        Ok(initial_event)
    }

    pub async fn cancel_transfer(&self, transfer_id: &str) -> AppResult<()> {
        let token = {
            let guard = self.cancels.lock().await;
            guard.get(transfer_id).cloned()
        };

        if let Some(tok) = token {
            tok.cancel();
            // If currently still Queued, mark Cancelled immediately for responsive UI feedback
            let mut maybe_cancelled = None;
            {
                let mut guard = self.items.write().await;
                if let Some(entry) = guard.iter_mut().find(|i| i.transfer_id == transfer_id) {
                    if entry.status == TransferStatus::Queued {
                        entry.status = TransferStatus::Cancelled;
                        entry.speed_bps = 0;
                        maybe_cancelled = Some(entry.clone());
                    }
                }
            }
            if let Some(ev) = maybe_cancelled {
                self.broadcast(&ev).await;
            }
            Ok(())
        } else {
            Ok(())
        }
    }

    async fn process_job(&self, job: QueuedJob) {
        if job.cancel_token.is_cancelled() {
            self.finish_job(&job, TransferStatus::Cancelled, 0, 0, 0, None)
                .await;
            return;
        }

        let started_at = Instant::now();
        let outcome = match job.direction {
            TransferDirection::Upload => self.run_upload(&job, started_at).await,
            TransferDirection::Download => self.run_download(&job, started_at).await,
        };

        match outcome {
            Ok((bytes_done, bytes_total)) => {
                let elapsed = started_at.elapsed().as_secs_f64().max(0.001);
                let speed_bps = (bytes_done as f64 / elapsed) as u64;
                self.finish_job(
                    &job,
                    TransferStatus::Completed,
                    bytes_done,
                    bytes_total,
                    speed_bps,
                    None,
                )
                .await;
            }
            Err(AppError::Sftp(ref msg)) if msg == "__CANCELLED__" => {
                let (done, total) = self.current_progress(&job.transfer_id).await;
                self.finish_job(&job, TransferStatus::Cancelled, done, total, 0, None)
                    .await;
            }
            Err(err) => {
                if job.cancel_token.is_cancelled() {
                    let (done, total) = self.current_progress(&job.transfer_id).await;
                    self.finish_job(&job, TransferStatus::Cancelled, done, total, 0, None)
                        .await;
                } else {
                    let (done, total) = self.current_progress(&job.transfer_id).await;
                    self.finish_job(
                        &job,
                        TransferStatus::Failed,
                        done,
                        total,
                        0,
                        Some(err.to_string()),
                    )
                    .await;
                }
            }
        }
    }

    async fn acquire_worker_sftp(&self, profile_id: &str) -> AppResult<Arc<SftpSession>> {
        let (_, sftp) = self.sftp_manager.create_sftp_channel(profile_id).await?;
        Ok(sftp)
    }

    async fn run_upload(&self, job: &QueuedJob, started_at: Instant) -> AppResult<(u64, u64)> {
        let local_root = PathBuf::from(&job.source_path);
        let remote_root = normalize_remote_path(&job.dest_path);

        let meta = tokio::fs::metadata(&local_root).await?;
        let mut sftp = self.acquire_worker_sftp(&job.profile_id).await?;

        if meta.is_file() {
            let total = meta.len();
            self.emit_progress(job, &job.root_name, 0, total, 0).await;

            if let Some(parent) = parent_remote_path(&remote_root) {
                ensure_remote_dir_with_recovery(&self.sftp_manager, &job.profile_id, &mut sftp, &parent)
                    .await?;
            }

            let mut bytes_done = 0u64;
            self.upload_single_file(
                job,
                &mut sftp,
                &local_root,
                &remote_root,
                &job.root_name,
                &mut bytes_done,
                total,
                started_at,
            )
            .await?;

            let _ = sftp.close().await;
            return Ok((bytes_done, total));
        }

        // Recursive directory upload (Local -> Remote with strict POSIX `/` joins)
        let root_clone = local_root.clone();
        let remote_base = remote_root.clone();
        let (dirs_to_create, files_to_upload, total_bytes) =
            tokio::task::spawn_blocking(move || collect_local_tree(&root_clone, &remote_base))
                .await
                .map_err(|e| AppError::Sftp(format!("Directory scan failed: {}", e)))??;

        self.emit_progress(job, &job.root_name, 0, total_bytes, 0)
            .await;

        for remote_dir in &dirs_to_create {
            if job.cancel_token.is_cancelled() {
                return Err(AppError::Sftp("__CANCELLED__".into()));
            }
            ensure_remote_dir_with_recovery(
                &self.sftp_manager,
                &job.profile_id,
                &mut sftp,
                remote_dir,
            )
            .await?;
        }

        let mut bytes_done = 0u64;
        for (local_file, remote_file, label) in files_to_upload {
            if job.cancel_token.is_cancelled() {
                return Err(AppError::Sftp("__CANCELLED__".into()));
            }
            let display = format!("{}/{}", job.root_name, label);
            self.upload_single_file(
                job,
                &mut sftp,
                &local_file,
                &remote_file,
                &display,
                &mut bytes_done,
                total_bytes,
                started_at,
            )
            .await?;
        }

        let _ = sftp.close().await;
        Ok((bytes_done, total_bytes))
    }

    #[allow(clippy::too_many_arguments)]
    async fn upload_single_file(
        &self,
        job: &QueuedJob,
        sftp: &mut Arc<SftpSession>,
        local_file: &Path,
        remote_posix_file: &str,
        display_name: &str,
        bytes_done: &mut u64,
        bytes_total: u64,
        started_at: Instant,
    ) -> AppResult<()> {
        let mut reader = tokio::fs::File::open(local_file).await?;
        let remote_file_res = sftp.create(remote_posix_file).await;
        let mut writer = match remote_file_res {
            Ok(f) => f,
            Err(e) if is_channel_dropped_error(&e) => {
                *sftp = self.acquire_worker_sftp(&job.profile_id).await?;
                sftp.create(remote_posix_file).await?
            }
            Err(e) => return Err(AppError::from(e)),
        };

        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut last_emit = Instant::now() - PROGRESS_THROTTLE;

        loop {
            let n = tokio::select! {
                biased;
                _ = job.cancel_token.cancelled() => {
                    return Err(AppError::Sftp("__CANCELLED__".into()));
                }
                res = reader.read(&mut buf) => res?,
            };
            if n == 0 {
                break;
            }

            tokio::select! {
                biased;
                _ = job.cancel_token.cancelled() => {
                    return Err(AppError::Sftp("__CANCELLED__".into()));
                }
                res = writer.write_all(&buf[..n]) => {
                    res.map_err(|e| AppError::Io(e))?;
                }
            }

            *bytes_done += n as u64;
            if last_emit.elapsed() >= PROGRESS_THROTTLE {
                let elapsed = started_at.elapsed().as_secs_f64().max(0.001);
                let speed_bps = (*bytes_done as f64 / elapsed) as u64;
                self.emit_progress(job, display_name, *bytes_done, bytes_total, speed_bps)
                    .await;
                last_emit = Instant::now();
            }
        }

        writer.shutdown().await?;
        let elapsed = started_at.elapsed().as_secs_f64().max(0.001);
        let speed_bps = (*bytes_done as f64 / elapsed) as u64;
        self.emit_progress(job, display_name, *bytes_done, bytes_total, speed_bps)
            .await;
        Ok(())
    }

    async fn run_download(&self, job: &QueuedJob, started_at: Instant) -> AppResult<(u64, u64)> {
        let remote_root = normalize_remote_path(&job.source_path);
        let local_root = PathBuf::from(&job.dest_path);

        let mut sftp = self.acquire_worker_sftp(&job.profile_id).await?;
        let meta = match sftp.metadata(&remote_root).await {
            Ok(m) => m,
            Err(e) if is_channel_dropped_error(&e) => {
                sftp = self.acquire_worker_sftp(&job.profile_id).await?;
                sftp.metadata(&remote_root).await?
            }
            Err(e) => return Err(AppError::from(e)),
        };

        if !meta.is_dir() {
            let total = meta.size.unwrap_or(0);
            self.emit_progress(job, &job.root_name, 0, total, 0).await;

            if let Some(parent) = local_root.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }

            let mut bytes_done = 0u64;
            self.download_single_file(
                job,
                &mut sftp,
                &remote_root,
                &local_root,
                &job.root_name,
                &mut bytes_done,
                total,
                started_at,
            )
            .await?;

            let _ = sftp.close().await;
            return Ok((bytes_done, total));
        }

        // Recursive directory download (Remote -> Local for logs, binaries, core dumps)
        let mut local_dirs: Vec<PathBuf> = Vec::new();
        let mut files_to_download: Vec<(String, PathBuf, String)> = Vec::new();
        let mut total_bytes: u64 = 0;

        let mut stack: Vec<(String, PathBuf, String)> =
            vec![(remote_root.clone(), local_root.clone(), String::new())];

        while let Some((curr_remote, curr_local, rel_prefix)) = stack.pop() {
            if job.cancel_token.is_cancelled() {
                return Err(AppError::Sftp("__CANCELLED__".into()));
            }
            local_dirs.push(curr_local.clone());

            let listing = match sftp.read_dir(&curr_remote).await {
                Ok(l) => l,
                Err(e) if is_channel_dropped_error(&e) => {
                    sftp = self.acquire_worker_sftp(&job.profile_id).await?;
                    sftp.read_dir(&curr_remote).await?
                }
                Err(e) => return Err(AppError::from(e)),
            };

            for entry in listing {
                let name = entry.file_name();
                if name.is_empty()
                    || name == "."
                    || name == ".."
                    || name.starts_with(".labbridge.tmp.")
                {
                    continue;
                }
                let child_remote = join_remote_path(&curr_remote, &name);
                let child_local = curr_local.join(&name);
                let child_rel = if rel_prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", rel_prefix, name)
                };

                match entry.file_type() {
                    FileType::Dir => {
                        stack.push((child_remote, child_local, child_rel));
                    }
                    FileType::File => {
                        total_bytes += entry.metadata().size.unwrap_or(0);
                        files_to_download.push((child_remote, child_local, child_rel));
                    }
                    FileType::Symlink => {
                        // Follow regular-file symlinks (e.g. latest.log -> run_42.log), skip directory symlinks to prevent cycles
                        if let Ok(target_meta) = sftp.metadata(&child_remote).await {
                            if target_meta.is_regular() {
                                total_bytes += target_meta.size.unwrap_or(0);
                                files_to_download.push((child_remote, child_local, child_rel));
                            }
                        }
                    }
                    FileType::Other => {}
                }
            }
        }

        self.emit_progress(job, &job.root_name, 0, total_bytes, 0)
            .await;

        for dir in local_dirs {
            tokio::fs::create_dir_all(&dir).await?;
        }

        let mut bytes_done = 0u64;
        for (remote_file, local_file, rel_label) in files_to_download {
            if job.cancel_token.is_cancelled() {
                return Err(AppError::Sftp("__CANCELLED__".into()));
            }
            if let Some(parent) = local_file.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            let display = format!("{}/{}", job.root_name, rel_label);
            self.download_single_file(
                job,
                &mut sftp,
                &remote_file,
                &local_file,
                &display,
                &mut bytes_done,
                total_bytes,
                started_at,
            )
            .await?;
        }

        let _ = sftp.close().await;
        Ok((bytes_done, total_bytes))
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_single_file(
        &self,
        job: &QueuedJob,
        sftp: &mut Arc<SftpSession>,
        remote_posix_file: &str,
        local_file: &Path,
        display_name: &str,
        bytes_done: &mut u64,
        bytes_total: u64,
        started_at: Instant,
    ) -> AppResult<()> {
        let mut reader = match sftp.open(remote_posix_file).await {
            Ok(f) => f,
            Err(e) if is_channel_dropped_error(&e) => {
                *sftp = self.acquire_worker_sftp(&job.profile_id).await?;
                sftp.open(remote_posix_file).await?
            }
            Err(e) => return Err(AppError::from(e)),
        };

        let mut writer = tokio::fs::File::create(local_file).await?;
        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut last_emit = Instant::now() - PROGRESS_THROTTLE;

        loop {
            let n = tokio::select! {
                biased;
                _ = job.cancel_token.cancelled() => {
                    drop(writer);
                    let _ = tokio::fs::remove_file(local_file).await;
                    return Err(AppError::Sftp("__CANCELLED__".into()));
                }
                res = reader.read(&mut buf) => res?,
            };
            if n == 0 {
                break;
            }

            tokio::select! {
                biased;
                _ = job.cancel_token.cancelled() => {
                    drop(writer);
                    let _ = tokio::fs::remove_file(local_file).await;
                    return Err(AppError::Sftp("__CANCELLED__".into()));
                }
                res = writer.write_all(&buf[..n]) => res?,
            }

            *bytes_done += n as u64;
            if last_emit.elapsed() >= PROGRESS_THROTTLE {
                let elapsed = started_at.elapsed().as_secs_f64().max(0.001);
                let speed_bps = (*bytes_done as f64 / elapsed) as u64;
                self.emit_progress(job, display_name, *bytes_done, bytes_total, speed_bps)
                    .await;
                last_emit = Instant::now();
            }
        }

        writer.flush().await?;
        let elapsed = started_at.elapsed().as_secs_f64().max(0.001);
        let speed_bps = (*bytes_done as f64 / elapsed) as u64;
        self.emit_progress(job, display_name, *bytes_done, bytes_total, speed_bps)
            .await;
        Ok(())
    }

    async fn emit_progress(
        &self,
        job: &QueuedJob,
        file_name: &str,
        bytes_done: u64,
        bytes_total: u64,
        speed_bps: u64,
    ) {
        let ev = TransferProgressEvent {
            transfer_id: job.transfer_id.clone(),
            profile_id: job.profile_id.clone(),
            direction: job.direction,
            file_name: file_name.to_string(),
            source_path: job.source_path.clone(),
            dest_path: job.dest_path.clone(),
            bytes_done,
            bytes_total,
            speed_bps,
            status: TransferStatus::InProgress,
            error: None,
        };
        {
            let mut guard = self.items.write().await;
            if let Some(existing) = guard.iter_mut().find(|i| i.transfer_id == job.transfer_id) {
                *existing = ev.clone();
            }
        }
        self.broadcast(&ev).await;
    }

    async fn finish_job(
        &self,
        job: &QueuedJob,
        status: TransferStatus,
        bytes_done: u64,
        bytes_total: u64,
        speed_bps: u64,
        error: Option<String>,
    ) {
        self.cancels.lock().await.remove(&job.transfer_id);

        let ev = TransferProgressEvent {
            transfer_id: job.transfer_id.clone(),
            profile_id: job.profile_id.clone(),
            direction: job.direction,
            file_name: job.root_name.clone(),
            source_path: job.source_path.clone(),
            dest_path: job.dest_path.clone(),
            bytes_done,
            bytes_total,
            speed_bps,
            status,
            error,
        };

        {
            let mut guard = self.items.write().await;
            if let Some(existing) = guard.iter_mut().find(|i| i.transfer_id == job.transfer_id) {
                *existing = ev.clone();
            }
        }
        self.broadcast(&ev).await;
    }

    async fn current_progress(&self, transfer_id: &str) -> (u64, u64) {
        let guard = self.items.read().await;
        guard
            .iter()
            .find(|i| i.transfer_id == transfer_id)
            .map(|i| (i.bytes_done, i.bytes_total))
            .unwrap_or((0, 0))
    }

    async fn broadcast(&self, event: &TransferProgressEvent) {
        let mut subs = self.subscribers.lock().await;
        subs.retain(|ch| ch.send(event.clone()).is_ok());
    }
}

async fn ensure_remote_dir_with_recovery(
    sftp_manager: &SftpManager,
    profile_id: &str,
    sftp: &mut Arc<SftpSession>,
    remote_dir: &str,
) -> AppResult<()> {
    match ensure_remote_dir_all(sftp, remote_dir).await {
        Ok(()) => Ok(()),
        Err(e) if is_channel_dropped_error(&e) => {
            let (_, fresh) = sftp_manager.create_sftp_channel(profile_id).await?;
            *sftp = fresh;
            ensure_remote_dir_all(sftp, remote_dir)
                .await
                .map_err(AppError::from)
        }
        Err(e) => Err(AppError::from(e)),
    }
}

fn collect_local_tree(
    local_root: &Path,
    remote_root: &str,
) -> AppResult<(Vec<String>, Vec<(PathBuf, String, String)>, u64)> {
    let mut dirs = vec![normalize_remote_path(remote_root)];
    let mut files = Vec::new();
    let mut total_bytes = 0u64;

    for entry_res in walkdir::WalkDir::new(local_root).follow_links(false) {
        let entry = entry_res.map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
        let path = entry.path();
        if path == local_root {
            continue;
        }
        let rel = path
            .strip_prefix(local_root)
            .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;

        // Strictly convert relative components into POSIX `/` segments regardless of Windows `\`
        let mut posix_parts = Vec::new();
        for comp in rel.components() {
            if let Component::Normal(os) = comp {
                posix_parts.push(os.to_string_lossy().into_owned());
            }
        }
        if posix_parts.is_empty() {
            continue;
        }
        let rel_posix = posix_parts.join("/");
        let target_remote = join_remote_path(remote_root, &rel_posix);

        let ft = entry.file_type();
        if ft.is_dir() {
            dirs.push(target_remote);
        } else if ft.is_file() {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            total_bytes += size;
            files.push((path.to_path_buf(), target_remote, rel_posix));
        }
    }

    Ok((dirs, files, total_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn collect_local_tree_emits_strict_posix_remote_paths() {
        let base = std::env::temp_dir().join(format!("labbridge_tree_{}", Uuid::new_v4()));
        let nested = base.join("logs").join("sub");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("core.dump"), b"hello-lab").unwrap();

        let (dirs, files, total_bytes) =
            collect_local_tree(&base, r"\var\crash\run_01\").expect("collect tree");

        assert_eq!(total_bytes, 9);
        for d in &dirs {
            assert!(!d.contains('\\'), "Remote dir contained backslash: {}", d);
            assert!(d.starts_with("/var/crash/run_01"));
        }
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].1, "/var/crash/run_01/logs/sub/core.dump");
        assert_eq!(files[0].2, "logs/sub/core.dump");

        let _ = fs::remove_dir_all(&base);
    }
}
