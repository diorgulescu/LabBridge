use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify_debouncer_full::notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, watch, Mutex, RwLock};
use uuid::Uuid;

use crate::config::{ConfigStore, WorkspaceProfile};
use crate::error::{AppError, AppResult};
use crate::sftp::local_fs::resolve_local_path;
use crate::sftp::SftpManager;
use crate::ssh::SshManager;
use crate::sync::filter::{
    has_active_git_lock, is_inside_git_dir, to_relative_posix, walk_syncable_files, ProjectFilter,
};
use crate::sync::reconcile::reconcile_workspace_impl;
use crate::sync::sanitizer::{prepare_file_for_sync, PreparedSyncFile, RemoteModeCache};
use crate::sync::types::{
    ReconcileReport, SyncBatchLogEntry, SyncStatusPayload, SyncStatusState, SyncStrategy,
    EVENT_SYNC_BATCH_LOGGED, EVENT_SYNC_STATUS_CHANGED,
};
use crate::sync::uploader::{execute_hybrid_batch, select_upload_strategy};

const DEBOUNCE_WINDOW: Duration = Duration::from_millis(350);
const POST_GIT_LOCK_QUIET_WINDOW: Duration = Duration::from_millis(250);
const GIT_LOCK_POLL_INTERVAL: Duration = Duration::from_millis(90);
const MAX_ACTIVITY_LOG_ENTRIES: usize = 200;

enum WorkerControlMsg {
    FsEvents(Vec<PathBuf>),
    PolicyUpdated(WorkspaceProfile),
    RetryNow,
    FlushPending(oneshot::Sender<AppResult<()>>),
}

struct RunningProfileSync {
    stop_tx: watch::Sender<bool>,
    ctrl_tx: mpsc::UnboundedSender<WorkerControlMsg>,
}

pub struct SyncManager {
    config_store: Arc<ConfigStore>,
    ssh_manager: Arc<SshManager>,
    sftp_manager: Arc<SftpManager>,
    mode_caches: RwLock<HashMap<String, Arc<RemoteModeCache>>>,
    statuses: RwLock<HashMap<String, SyncStatusPayload>>,
    activity_logs: RwLock<HashMap<String, VecDeque<SyncBatchLogEntry>>>,
    workers: Mutex<HashMap<String, RunningProfileSync>>,
}

impl SyncManager {
    pub fn new(
        config_store: Arc<ConfigStore>,
        ssh_manager: Arc<SshManager>,
        sftp_manager: Arc<SftpManager>,
    ) -> Arc<Self> {
        Arc::new(Self {
            config_store,
            ssh_manager,
            sftp_manager,
            mode_caches: RwLock::new(HashMap::new()),
            statuses: RwLock::new(HashMap::new()),
            activity_logs: RwLock::new(HashMap::new()),
            workers: Mutex::new(HashMap::new()),
        })
    }

    pub async fn get_mode_cache(&self, profile_id: &str) -> Arc<RemoteModeCache> {
        {
            let guard = self.mode_caches.read().await;
            if let Some(existing) = guard.get(profile_id) {
                return Arc::clone(existing);
            }
        }
        let mut guard = self.mode_caches.write().await;
        Arc::clone(
            guard
                .entry(profile_id.to_string())
                .or_insert_with(|| Arc::new(RemoteModeCache::new())),
        )
    }

    pub async fn get_status(&self, profile_id: &str) -> AppResult<SyncStatusPayload> {
        if let Some(existing) = self.statuses.read().await.get(profile_id).cloned() {
            return Ok(existing);
        }
        let profile = self.config_store.get_profile(profile_id)?;
        Ok(SyncStatusPayload {
            profile_id: profile.id,
            status: SyncStatusState::Inactive,
            auto_sync_enabled: profile.auto_sync_enabled,
            crlf_guard_enabled: profile.crlf_guard_enabled,
            sync_deletions: profile.sync_deletions,
            local_root_path: profile.local_root_path,
            remote_root_path: profile.remote_root_path,
        })
    }

    pub async fn get_activity_log(&self, profile_id: &str) -> Vec<SyncBatchLogEntry> {
        self.activity_logs
            .read()
            .await
            .get(profile_id)
            .map(|q| q.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub async fn clear_activity_log(&self, profile_id: &str) {
        if let Some(q) = self.activity_logs.write().await.get_mut(profile_id) {
            q.clear();
        }
    }

    /// Starts the real-time watcher and triggers initial reconciliation if paths are configured.
    pub async fn start_for_profile(
        self: &Arc<Self>,
        app_handle: AppHandle,
        profile_id: &str,
    ) -> AppResult<()> {
        self.stop_for_profile(&app_handle, profile_id).await;

        let profile = self.config_store.get_profile(profile_id)?;
        if profile.local_root_path.trim().is_empty() || profile.remote_root_path.trim().is_empty() {
            self.emit_status(&app_handle, &profile, SyncStatusState::Inactive)
                .await;
            return Ok(());
        }

        let local_root = match resolve_local_path(Some(&profile.local_root_path)) {
            Ok(p) if p.is_dir() => p,
            Ok(p) => {
                self.emit_status(
                    &app_handle,
                    &profile,
                    SyncStatusState::Error {
                        message: format!("Local root directory not found: {}", p.display()),
                    },
                )
                .await;
                return Ok(());
            }
            Err(e) => {
                self.emit_status(
                    &app_handle,
                    &profile,
                    SyncStatusState::Error {
                        message: e.to_string(),
                    },
                )
                .await;
                return Ok(());
            }
        };

        let (stop_tx, stop_rx) = watch::channel(false);
        let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel::<WorkerControlMsg>();

        {
            let mut workers = self.workers.lock().await;
            workers.insert(
                profile_id.to_string(),
                RunningProfileSync {
                    stop_tx,
                    ctrl_tx: ctrl_tx.clone(),
                },
            );
        }

        let mgr = Arc::clone(self);
        let app_clone = app_handle.clone();
        let initial_profile = profile.clone();
        tokio::spawn(async move {
            mgr.run_profile_sync_worker(
                app_clone,
                initial_profile,
                local_root,
                ctrl_tx,
                ctrl_rx,
                stop_rx,
            )
            .await;
        });

        Ok(())
    }

    pub async fn stop_for_profile(&self, app_handle: &AppHandle, profile_id: &str) {
        if let Some(running) = self.workers.lock().await.remove(profile_id) {
            let _ = running.stop_tx.send(true);
        }
        if let Ok(profile) = self.config_store.get_profile(profile_id) {
            self.emit_status(app_handle, &profile, SyncStatusState::Inactive)
                .await;
        }
    }

    pub async fn stop_all(&self) {
        let mut workers = self.workers.lock().await;
        for (_, running) in workers.drain() {
            let _ = running.stop_tx.send(true);
        }
    }

    pub async fn update_policy(
        self: &Arc<Self>,
        app_handle: &AppHandle,
        profile_id: &str,
        auto_sync_enabled: bool,
        crlf_guard_enabled: bool,
        sync_deletions: bool,
    ) -> AppResult<SyncStatusPayload> {
        let updated_profile = self.config_store.update_sync_policy(
            profile_id,
            auto_sync_enabled,
            crlf_guard_enabled,
            sync_deletions,
        )?;

        let maybe_ctrl = {
            let workers = self.workers.lock().await;
            workers.get(profile_id).map(|w| w.ctrl_tx.clone())
        };

        if let Some(tx) = maybe_ctrl {
            let _ = tx.send(WorkerControlMsg::PolicyUpdated(updated_profile.clone()));
        } else {
            let next_state = if !auto_sync_enabled {
                SyncStatusState::Paused { buffered_files: 0 }
            } else {
                SyncStatusState::Inactive
            };
            self.emit_status(app_handle, &updated_profile, next_state)
                .await;
        }

        self.get_status(profile_id).await
    }

    pub async fn retry_sync(&self, profile_id: &str) -> AppResult<()> {
        let maybe_ctrl = {
            let workers = self.workers.lock().await;
            workers.get(profile_id).map(|w| w.ctrl_tx.clone())
        };
        if let Some(tx) = maybe_ctrl {
            let _ = tx.send(WorkerControlMsg::RetryNow);
        }
        Ok(())
    }

    /// Awaits any in-flight or queued sync batch (including recently saved files inside the 350ms
    /// debounce window or held behind a Git lock) before returning, so build/flash macros run on fresh code.
    pub async fn flush_pending_sync(&self, profile_id: &str) -> AppResult<()> {
        let maybe_ctrl = {
            let workers = self.workers.lock().await;
            workers.get(profile_id).map(|w| w.ctrl_tx.clone())
        };
        let Some(tx) = maybe_ctrl else {
            return Ok(());
        };

        let (reply_tx, reply_rx) = oneshot::channel();
        if tx.send(WorkerControlMsg::FlushPending(reply_tx)).is_err() {
            return Ok(());
        }

        tokio::time::timeout(Duration::from_secs(30), reply_rx)
            .await
            .map_err(|_| AppError::Sync("Timed out waiting for pending sync batch to flush".into()))?
            .map_err(|_| AppError::Sync("Sync worker stopped while flushing".into()))?
    }

    /// Runs workspace reconciliation on demand (`dry_run == true` for Check Dry-Run, `false` for Push Diff).
    pub async fn reconcile_workspace(
        self: &Arc<Self>,
        app_handle: &AppHandle,
        profile_id: &str,
        dry_run: bool,
    ) -> AppResult<ReconcileReport> {
        let profile = self.config_store.get_profile(profile_id)?;
        let mode_cache = self.get_mode_cache(profile_id).await;

        if !dry_run {
            self.emit_status(
                app_handle,
                &profile,
                SyncStatusState::Syncing {
                    file_count: 0,
                    strategy: SyncStrategy::TarStream,
                },
            )
            .await;
        }

        match reconcile_workspace_impl(
            &self.ssh_manager,
            &self.sftp_manager,
            &mode_cache,
            &profile,
            dry_run,
        )
        .await
        {
            Ok(exec_res) => {
                if !dry_run {
                    if let Some(strategy) = exec_res.strategy_used {
                        let mut affected = exec_res.uploaded_files.clone();
                        for del in &exec_res.deleted_files {
                            affected.push(format!("- {}", del));
                        }
                        self.record_batch_log(
                            app_handle,
                            SyncBatchLogEntry {
                                id: Uuid::new_v4().to_string(),
                                profile_id: profile.id.clone(),
                                timestamp_ms: now_epoch_ms(),
                                strategy,
                                duration_ms: exec_res.report.duration_ms,
                                files: affected,
                                bytes_transferred: exec_res.bytes_transferred,
                                crlf_converted_count: exec_res.crlf_converted_count,
                                deleted_count: exec_res.deleted_files.len(),
                                success: true,
                                error: None,
                            },
                        )
                        .await;
                    }

                    let post_state = if profile.auto_sync_enabled {
                        SyncStatusState::Idle {
                            last_synced_ms: Some(now_epoch_ms()),
                        }
                    } else {
                        SyncStatusState::Paused { buffered_files: 0 }
                    };
                    self.emit_status(app_handle, &profile, post_state).await;
                }
                Ok(exec_res.report)
            }
            Err(err) => {
                if !dry_run {
                    self.emit_status(
                        app_handle,
                        &profile,
                        SyncStatusState::Error {
                            message: err.to_string(),
                        },
                    )
                    .await;
                }
                Err(err)
            }
        }
    }

    async fn run_profile_sync_worker(
        self: Arc<Self>,
        app_handle: AppHandle,
        mut profile: WorkspaceProfile,
        local_root: PathBuf,
        ctrl_tx_for_watcher: mpsc::UnboundedSender<WorkerControlMsg>,
        mut ctrl_rx: mpsc::UnboundedReceiver<WorkerControlMsg>,
        mut stop_rx: watch::Receiver<bool>,
    ) {
        let mode_cache = self.get_mode_cache(&profile.id).await;

        // Start 350ms recursive debounced filesystem watcher
        let watcher_tx = ctrl_tx_for_watcher;
        let debouncer_res = new_debouncer(
            DEBOUNCE_WINDOW,
            None,
            move |result: DebounceEventResult| {
                if let Ok(events) = result {
                    let mut paths = Vec::new();
                    for ev in events {
                        for p in &ev.paths {
                            paths.push(p.clone());
                        }
                    }
                    if !paths.is_empty() {
                        let _ = watcher_tx.send(WorkerControlMsg::FsEvents(paths));
                    }
                }
            },
        );

        let mut _debouncer = match debouncer_res {
            Ok(mut d) => {
                if let Err(err) = d.watch(&local_root, RecursiveMode::Recursive) {
                    self.emit_status(
                        &app_handle,
                        &profile,
                        SyncStatusState::Error {
                            message: format!("Failed to watch '{}': {}", local_root.display(), err),
                        },
                    )
                    .await;
                    return;
                }
                d
            }
            Err(err) => {
                self.emit_status(
                    &app_handle,
                    &profile,
                    SyncStatusState::Error {
                        message: format!("Failed to initialize file watcher: {}", err),
                    },
                )
                .await;
                return;
            }
        };

        // Run initial fast workspace reconciliation on connect when auto-sync is enabled
        if profile.auto_sync_enabled {
            let _ = self
                .reconcile_workspace(&app_handle, &profile.id, false)
                .await;
        } else {
            self.emit_status(
                &app_handle,
                &profile,
                SyncStatusState::Paused { buffered_files: 0 },
            )
            .await;
        }

        let mut dirty_upserts: HashSet<String> = HashSet::new();
        let mut dirty_deletes: HashSet<String> = HashSet::new();
        let mut git_locked = false;
        let mut post_lock_quiet_until: Option<Instant> = None;
        let mut flush_waiters: Vec<oneshot::Sender<AppResult<()>>> = Vec::new();
        let mut flush_coalesce_until: Option<Instant> = None;
        let mut last_synced_ms: Option<u64> = Some(now_epoch_ms());

        loop {
            let has_dirty = !dirty_upserts.is_empty() || !dirty_deletes.is_empty();
            let has_waiters = !flush_waiters.is_empty();

            let next_wake: Option<Duration> = if !has_waiters && (!profile.auto_sync_enabled || !has_dirty) {
                None
            } else if git_locked {
                Some(GIT_LOCK_POLL_INTERVAL)
            } else if let Some(deadline) = post_lock_quiet_until {
                let now = Instant::now();
                if deadline > now {
                    Some(deadline - now)
                } else {
                    Some(Duration::ZERO)
                }
            } else if !has_dirty && has_waiters {
                if let Some(deadline) = flush_coalesce_until {
                    let now = Instant::now();
                    if deadline > now {
                        Some(deadline - now)
                    } else {
                        Some(Duration::ZERO)
                    }
                } else {
                    Some(Duration::ZERO)
                }
            } else {
                Some(Duration::ZERO)
            };

            tokio::select! {
                biased;
                _ = wait_stopped(&mut stop_rx) => {
                    break;
                }
                maybe_msg = ctrl_rx.recv() => {
                    let Some(msg) = maybe_msg else { break; };
                    match msg {
                        WorkerControlMsg::FsEvents(paths) => {
                            let Ok(filter) = ProjectFilter::build(&local_root, &profile.excluded_dirs) else {
                                continue;
                            };

                            let mut saw_git_event = false;
                            for abs_path in paths {
                                if is_inside_git_dir(&local_root, &abs_path) {
                                    saw_git_event = true;
                                    continue;
                                }
                                ingest_changed_path(
                                    &local_root,
                                    &abs_path,
                                    &filter,
                                    &mut dirty_upserts,
                                    &mut dirty_deletes,
                                );
                            }

                            let lock_now = has_active_git_lock(&local_root);
                            if lock_now {
                                git_locked = true;
                                post_lock_quiet_until = None;
                            } else if git_locked {
                                // Lock just cleared -> start 250ms post-lock quiet window!
                                git_locked = false;
                                post_lock_quiet_until = Some(Instant::now() + POST_GIT_LOCK_QUIET_WINDOW);
                            } else if post_lock_quiet_until.is_some() && !saw_git_event {
                                // Extend post-lock quiet window if files are still settling
                                post_lock_quiet_until = Some(Instant::now() + POST_GIT_LOCK_QUIET_WINDOW);
                            }

                            let buffered = dirty_upserts.len() + dirty_deletes.len();
                            if !profile.auto_sync_enabled {
                                self.emit_status(
                                    &app_handle,
                                    &profile,
                                    SyncStatusState::Paused { buffered_files: buffered },
                                ).await;
                            } else if git_locked && buffered > 0 {
                                self.emit_status(
                                    &app_handle,
                                    &profile,
                                    SyncStatusState::WaitingOnGitLock { buffered_files: buffered },
                                ).await;
                            }
                        }
                        WorkerControlMsg::PolicyUpdated(next_profile) => {
                            let was_paused = !profile.auto_sync_enabled;
                            profile = next_profile;
                            let buffered = dirty_upserts.len() + dirty_deletes.len();
                            if !profile.auto_sync_enabled {
                                self.emit_status(
                                    &app_handle,
                                    &profile,
                                    SyncStatusState::Paused { buffered_files: buffered },
                                ).await;
                            } else if was_paused && buffered == 0 {
                                self.emit_status(
                                    &app_handle,
                                    &profile,
                                    SyncStatusState::Idle { last_synced_ms },
                                ).await;
                            }
                        }
                        WorkerControlMsg::RetryNow => {
                            if dirty_upserts.is_empty() && dirty_deletes.is_empty() {
                                let _ = self.reconcile_workspace(&app_handle, &profile.id, false).await;
                            }
                        }
                        WorkerControlMsg::FlushPending(reply_tx) => {
                            flush_waiters.push(reply_tx);
                            if dirty_upserts.is_empty() && dirty_deletes.is_empty() && !has_active_git_lock(&local_root) {
                                // Allow a brief 380ms window to catch any save still inside notify's 350ms debouncer
                                flush_coalesce_until = Some(Instant::now() + Duration::from_millis(380));
                            } else {
                                flush_coalesce_until = None;
                            }
                        }
                    }
                }
                _ = async {
                    match next_wake {
                        Some(d) => tokio::time::sleep(d).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    // Check Git lock state before flushing!
                    if has_active_git_lock(&local_root) {
                        git_locked = true;
                        post_lock_quiet_until = None;
                        let buffered = dirty_upserts.len() + dirty_deletes.len();
                        self.emit_status(
                            &app_handle,
                            &profile,
                            SyncStatusState::WaitingOnGitLock { buffered_files: buffered },
                        ).await;
                        continue;
                    }

                    if git_locked {
                        git_locked = false;
                        post_lock_quiet_until = Some(Instant::now() + POST_GIT_LOCK_QUIET_WINDOW);
                        continue;
                    }

                    if let Some(deadline) = post_lock_quiet_until {
                        if Instant::now() < deadline {
                            continue;
                        }
                        post_lock_quiet_until = None;
                    }

                    if dirty_upserts.is_empty() && dirty_deletes.is_empty() {
                        if let Some(deadline) = flush_coalesce_until {
                            if Instant::now() < deadline {
                                continue;
                            }
                            flush_coalesce_until = None;
                        }
                        for waiter in flush_waiters.drain(..) {
                            let _ = waiter.send(Ok(()));
                        }
                        continue;
                    }

                    if !profile.auto_sync_enabled && flush_waiters.is_empty() {
                        continue;
                    }
                    flush_coalesce_until = None;

                    // Drain current dirty batch for upload
                    let batch_upserts: Vec<String> = dirty_upserts.drain().collect();
                    let batch_deletes: Vec<String> = dirty_deletes.drain().collect();

                    let flush_res = self.flush_dirty_batch(
                        &app_handle,
                        &profile,
                        &local_root,
                        &mode_cache,
                        &batch_upserts,
                        &batch_deletes,
                    ).await;

                    match flush_res {
                        Ok(did_sync) => {
                            if did_sync {
                                last_synced_ms = Some(now_epoch_ms());
                            }
                            for waiter in flush_waiters.drain(..) {
                                let _ = waiter.send(Ok(()));
                            }
                            let post_state = if profile.auto_sync_enabled {
                                SyncStatusState::Idle { last_synced_ms }
                            } else {
                                SyncStatusState::Paused { buffered_files: 0 }
                            };
                            self.emit_status(
                                &app_handle,
                                &profile,
                                post_state,
                            ).await;
                        }
                        Err(err) => {
                            let err_msg = err.to_string();
                            for waiter in flush_waiters.drain(..) {
                                let _ = waiter.send(Err(AppError::Sync(err_msg.clone())));
                            }
                            // Re-queue failed paths so Retry never drops edits
                            for u in batch_upserts {
                                dirty_upserts.insert(u);
                            }
                            for d in batch_deletes {
                                dirty_deletes.insert(d);
                            }
                            self.emit_status(
                                &app_handle,
                                &profile,
                                SyncStatusState::Error {
                                    message: err_msg,
                                },
                            ).await;
                            // Brief backoff before re-attempting or waiting for manual retry
                            tokio::select! {
                                _ = wait_stopped(&mut stop_rx) => break,
                                _ = tokio::time::sleep(Duration::from_secs(4)) => {}
                            }
                        }
                    }
                }
            }
        }
    }

    async fn flush_dirty_batch(
        &self,
        app_handle: &AppHandle,
        profile: &WorkspaceProfile,
        local_root: &Path,
        mode_cache: &Arc<RemoteModeCache>,
        upsert_rels: &[String],
        delete_rels: &[String],
    ) -> AppResult<bool> {
        let started = Instant::now();
        let filter = ProjectFilter::build(local_root, &profile.excluded_dirs)?;

        let mut prepared_files: Vec<PreparedSyncFile> = Vec::new();
        let mut effective_deletes: Vec<String> = Vec::new();

        for rel in upsert_rels {
            if filter.is_excluded_rel_posix(rel, false) {
                continue;
            }
            let abs = local_root.join(Path::new(rel));
            match std::fs::symlink_metadata(&abs) {
                Ok(meta) if meta.is_file() => {
                    let cached_mode = mode_cache.get(rel);
                    let prep = prepare_file_for_sync(
                        &abs,
                        rel,
                        profile.crlf_guard_enabled,
                        cached_mode,
                    )?;
                    prepared_files.push(prep);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    effective_deletes.push(rel.clone());
                }
                _ => {}
            }
        }

        for rel in delete_rels {
            if filter.is_excluded_rel_posix(rel, false) {
                continue;
            }
            let abs = local_root.join(Path::new(rel));
            if !abs.exists() && !effective_deletes.contains(rel) {
                effective_deletes.push(rel.clone());
            }
        }

        let deletions_to_run: &[String] = if profile.sync_deletions {
            &effective_deletes
        } else {
            &[]
        };

        if prepared_files.is_empty() && deletions_to_run.is_empty() {
            return Ok(false);
        }

        let strategy = select_upload_strategy(&prepared_files, false);
        let file_count = prepared_files.len() + deletions_to_run.len();

        self.emit_status(
            app_handle,
            profile,
            SyncStatusState::Syncing {
                file_count,
                strategy,
            },
        )
        .await;

        let crlf_converted_count = prepared_files.iter().filter(|f| f.crlf_converted).count();
        let mut affected_files: Vec<String> =
            prepared_files.iter().map(|f| f.rel_posix.clone()).collect();
        affected_files.sort();
        for del in deletions_to_run {
            affected_files.push(format!("- {}", del));
        }

        let outcome_res = execute_hybrid_batch(
            &self.ssh_manager,
            &self.sftp_manager,
            mode_cache,
            &profile.id,
            &profile.remote_root_path,
            prepared_files,
            deletions_to_run,
            profile.sync_deletions,
            false,
        )
        .await;

        let duration_ms = started.elapsed().as_millis() as u64;

        match outcome_res {
            Ok(outcome) => {
                self.record_batch_log(
                    app_handle,
                    SyncBatchLogEntry {
                        id: Uuid::new_v4().to_string(),
                        profile_id: profile.id.clone(),
                        timestamp_ms: now_epoch_ms(),
                        strategy: outcome.strategy,
                        duration_ms,
                        files: affected_files,
                        bytes_transferred: outcome.bytes_transferred,
                        crlf_converted_count,
                        deleted_count: deletions_to_run.len(),
                        success: true,
                        error: None,
                    },
                )
                .await;
                Ok(true)
            }
            Err(err) => {
                self.record_batch_log(
                    app_handle,
                    SyncBatchLogEntry {
                        id: Uuid::new_v4().to_string(),
                        profile_id: profile.id.clone(),
                        timestamp_ms: now_epoch_ms(),
                        strategy,
                        duration_ms,
                        files: affected_files,
                        bytes_transferred: 0,
                        crlf_converted_count,
                        deleted_count: 0,
                        success: false,
                        error: Some(err.to_string()),
                    },
                )
                .await;
                Err(err)
            }
        }
    }

    async fn emit_status(
        &self,
        app_handle: &AppHandle,
        profile: &WorkspaceProfile,
        status: SyncStatusState,
    ) {
        let payload = SyncStatusPayload {
            profile_id: profile.id.clone(),
            status,
            auto_sync_enabled: profile.auto_sync_enabled,
            crlf_guard_enabled: profile.crlf_guard_enabled,
            sync_deletions: profile.sync_deletions,
            local_root_path: profile.local_root_path.clone(),
            remote_root_path: profile.remote_root_path.clone(),
        };
        self.statuses
            .write()
            .await
            .insert(profile.id.clone(), payload.clone());
        let _ = app_handle.emit(EVENT_SYNC_STATUS_CHANGED, &payload);
    }

    async fn record_batch_log(&self, app_handle: &AppHandle, entry: SyncBatchLogEntry) {
        {
            let mut logs = self.activity_logs.write().await;
            let ring = logs
                .entry(entry.profile_id.clone())
                .or_insert_with(VecDeque::new);
            ring.push_front(entry.clone());
            while ring.len() > MAX_ACTIVITY_LOG_ENTRIES {
                ring.pop_back();
            }
        }
        let _ = app_handle.emit(EVENT_SYNC_BATCH_LOGGED, &entry);
    }
}

fn ingest_changed_path(
    local_root: &Path,
    abs_path: &Path,
    filter: &ProjectFilter,
    dirty_upserts: &mut HashSet<String>,
    dirty_deletes: &mut HashSet<String>,
) {
    let Some(rel_posix) = to_relative_posix(local_root, abs_path) else {
        return;
    };

    match std::fs::symlink_metadata(abs_path) {
        Ok(meta) if meta.is_file() => {
            if !filter.is_excluded_rel_posix(&rel_posix, false) {
                dirty_deletes.remove(&rel_posix);
                dirty_upserts.insert(rel_posix);
            }
        }
        Ok(meta) if meta.is_dir() => {
            if filter.is_excluded_rel_posix(&rel_posix, true) {
                return;
            }
            // Walk newly created/renamed directory so multi-file AI bursts inside new folders are never missed
            if let Ok(sub_files) = walk_syncable_files(abs_path, &[]) {
                for (sub_abs, _) in sub_files {
                    if let Some(full_rel) = to_relative_posix(local_root, &sub_abs) {
                        if !filter.is_excluded_rel_posix(&full_rel, false) {
                            dirty_deletes.remove(&full_rel);
                            dirty_upserts.insert(full_rel);
                        }
                    }
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if !filter.is_excluded_rel_posix(&rel_posix, false) {
                dirty_upserts.remove(&rel_posix);
                dirty_deletes.insert(rel_posix);
            }
        }
        _ => {}
    }
}

async fn wait_stopped(rx: &mut watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    while rx.changed().await.is_ok() {
        if *rx.borrow() {
            return;
        }
    }
    std::future::pending::<()>().await;
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
