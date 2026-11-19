use std::collections::HashMap;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::config::{
    ConfigStore, KnownHostEntry, ProfileMacro, SecretStatus, StorageInfo, WorkspaceProfile,
    WorkspaceUiState,
};
use crate::error::AppResult;
use crate::pty::PtyManager;
use crate::sftp::{
    self, DiffContentsResponse, DirListing, FileHashComparison, SftpManager, TransferDirection,
    TransferManager, TransferProgressEvent,
};
use crate::ssh::{ConnectionState, ConnectionStatusPayload, SshManager};
use crate::sync::{
    ReconcileReport, SyncBatchLogEntry, SyncManager, SyncStatusPayload,
};

pub struct AppState {
    pub config: Arc<ConfigStore>,
    pub ssh: Arc<SshManager>,
    pub pty: Arc<PtyManager>,
    pub sftp: Arc<SftpManager>,
    pub transfers: Arc<TransferManager>,
    pub sync: Arc<SyncManager>,
}

// ---------------------------------------------------------------------------
// Storage, Profiles & Known Hosts Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn storage_get_info(state: State<'_, AppState>) -> AppResult<StorageInfo> {
    Ok(state.config.storage_info())
}

#[tauri::command]
pub async fn profiles_list(state: State<'_, AppState>) -> AppResult<Vec<WorkspaceProfile>> {
    state.config.list_profiles()
}

#[tauri::command]
pub async fn profile_save(
    app_handle: AppHandle,
    profile: WorkspaceProfile,
    target_secret: Option<String>,
    proxy_secret: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<WorkspaceProfile> {
    let saved = tokio::task::spawn_blocking({
        let config = Arc::clone(&state.config);
        move || config.save_profile(profile, target_secret, proxy_secret)
    })
    .await
    .map_err(|e| crate::error::AppError::Config(format!("Join error: {}", e)))??;

    // If profile is currently connected, refresh live SyncEngine configuration
    let conn = state.ssh.get_state(&saved.id).await;
    if matches!(conn.connection_state, ConnectionState::Connected { .. }) {
        let _ = state.sync.start_for_profile(app_handle, &saved.id).await;
    }

    Ok(saved)
}

#[tauri::command]
pub async fn profile_duplicate(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<WorkspaceProfile> {
    tokio::task::spawn_blocking({
        let config = Arc::clone(&state.config);
        move || config.duplicate_profile(&profile_id)
    })
    .await
    .map_err(|e| crate::error::AppError::Config(format!("Join error: {}", e)))?
}

#[tauri::command]
pub async fn profile_delete(
    app_handle: AppHandle,
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.sync.stop_for_profile(&app_handle, &profile_id).await;
    state.pty.close_all_for_profile(&profile_id).await;
    state.sftp.invalidate(&profile_id).await;
    let _ = state.ssh.disconnect(&app_handle, &profile_id).await;

    tokio::task::spawn_blocking({
        let config = Arc::clone(&state.config);
        move || config.delete_profile(&profile_id)
    })
    .await
    .map_err(|e| crate::error::AppError::Config(format!("Join error: {}", e)))?
}

#[tauri::command]
pub async fn profile_secret_status(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<SecretStatus> {
    tokio::task::spawn_blocking({
        let config = Arc::clone(&state.config);
        move || Ok(config.secret_status(&profile_id))
    })
    .await
    .map_err(|e| crate::error::AppError::Config(format!("Join error: {}", e)))?
}

#[tauri::command]
pub async fn known_hosts_list(state: State<'_, AppState>) -> AppResult<Vec<KnownHostEntry>> {
    state.config.known_hosts.list_entries()
}

#[tauri::command]
pub async fn known_hosts_remove(
    host_id: String,
    algorithm: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.config.known_hosts.remove_entry(&host_id, &algorithm)
}

// ---------------------------------------------------------------------------
// Multiplexed SSH Engine Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ssh_connect(
    app_handle: AppHandle,
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<ConnectionStatusPayload> {
    let status = state.ssh.connect(app_handle.clone(), &profile_id).await?;
    let sync = Arc::clone(&state.sync);
    let pid = profile_id.clone();
    tokio::spawn(async move {
        let _ = sync.start_for_profile(app_handle, &pid).await;
    });
    Ok(status)
}

#[tauri::command]
pub async fn ssh_disconnect(
    app_handle: AppHandle,
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<ConnectionStatusPayload> {
    state.sync.stop_for_profile(&app_handle, &profile_id).await;
    state.pty.close_all_for_profile(&profile_id).await;
    state.sftp.invalidate(&profile_id).await;
    state.ssh.disconnect(&app_handle, &profile_id).await
}

#[tauri::command]
pub async fn ssh_get_state(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<ConnectionStatusPayload> {
    Ok(state.ssh.get_state(&profile_id).await)
}

#[tauri::command]
pub async fn ssh_list_states(
    state: State<'_, AppState>,
) -> AppResult<HashMap<String, ConnectionStatusPayload>> {
    Ok(state.ssh.list_states().await)
}

#[tauri::command]
pub async fn ssh_respond_host_key(
    request_id: String,
    accept: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.ssh.respond_host_key(&request_id, accept).await
}

// ---------------------------------------------------------------------------
// Multiplexed PTY Manager Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pty_open(
    app_handle: AppHandle,
    profile_id: String,
    cols: u32,
    rows: u32,
    on_data: Channel<Vec<u8>>,
    state: State<'_, AppState>,
) -> AppResult<String> {
    state
        .pty
        .open_pty(app_handle, &profile_id, cols, rows, on_data)
        .await
}

#[tauri::command]
pub async fn pty_write(
    tab_id: String,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.pty.write_pty(&tab_id, data).await
}

#[tauri::command]
pub async fn pty_resize(
    tab_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.pty.resize_pty(&tab_id, cols, rows).await
}

#[tauri::command]
pub async fn pty_close(tab_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.pty.close_pty(&tab_id).await
}

// ---------------------------------------------------------------------------
// Phase 2: Dual-Pane Local & SFTP Filesystem Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fs_local_list_dir(path: Option<String>) -> AppResult<DirListing> {
    tokio::task::spawn_blocking(move || sftp::local_list_dir(path.as_deref()))
        .await
        .map_err(|e| crate::error::AppError::Config(format!("Join error: {}", e)))?
}

#[tauri::command]
pub async fn fs_local_create_dir(path: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || sftp::local_create_dir(&path))
        .await
        .map_err(|e| crate::error::AppError::Config(format!("Join error: {}", e)))?
}

#[tauri::command]
pub async fn fs_local_rename(old_path: String, new_path: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || sftp::local_rename(&old_path, &new_path))
        .await
        .map_err(|e| crate::error::AppError::Config(format!("Join error: {}", e)))?
}

#[tauri::command]
pub async fn fs_local_delete(path: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || sftp::local_delete(&path))
        .await
        .map_err(|e| crate::error::AppError::Config(format!("Join error: {}", e)))?
}

#[tauri::command]
pub async fn sftp_list_dir(
    profile_id: String,
    path: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<DirListing> {
    sftp::remote_list_dir(&state.sftp, &profile_id, path.as_deref()).await
}

#[tauri::command]
pub async fn sftp_create_dir(
    profile_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    sftp::remote_create_dir(&state.sftp, &profile_id, &path).await
}

#[tauri::command]
pub async fn sftp_rename(
    profile_id: String,
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    sftp::remote_rename(&state.sftp, &profile_id, &old_path, &new_path).await
}

#[tauri::command]
pub async fn sftp_delete(
    profile_id: String,
    path: String,
    recursive: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    sftp::remote_delete(&state.sftp, &profile_id, &path, recursive).await
}

#[tauri::command]
pub async fn sftp_chmod(
    profile_id: String,
    path: String,
    mode: u32,
    state: State<'_, AppState>,
) -> AppResult<()> {
    sftp::remote_chmod(&state.sftp, &profile_id, &path, mode).await
}

// ---------------------------------------------------------------------------
// Phase 2: Async Transfer Queue Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn transfer_subscribe(
    on_progress: Channel<TransferProgressEvent>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.transfers.subscribe(on_progress).await
}

#[tauri::command]
pub async fn transfer_enqueue(
    profile_id: String,
    direction: TransferDirection,
    source_path: String,
    dest_path: String,
    state: State<'_, AppState>,
) -> AppResult<TransferProgressEvent> {
    state
        .transfers
        .enqueue_transfer(profile_id, direction, source_path, dest_path)
        .await
}

#[tauri::command]
pub async fn transfer_cancel(
    transfer_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.transfers.cancel_transfer(&transfer_id).await
}

#[tauri::command]
pub async fn transfer_list(state: State<'_, AppState>) -> AppResult<Vec<TransferProgressEvent>> {
    Ok(state.transfers.list_transfers().await)
}

#[tauri::command]
pub async fn transfer_clear_finished(state: State<'_, AppState>) -> AppResult<()> {
    state.transfers.clear_finished().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Phase 2: Quick Diff & External VS Code Launch Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn compare_file_hashes(
    profile_id: String,
    local_path: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> AppResult<FileHashComparison> {
    sftp::compare_file_hashes(&state.ssh, &state.sftp, &profile_id, &local_path, &remote_path).await
}

#[tauri::command]
pub async fn diff_read_contents(
    profile_id: String,
    local_path: String,
    remote_path: String,
    max_bytes: Option<usize>,
    state: State<'_, AppState>,
) -> AppResult<DiffContentsResponse> {
    sftp::read_diff_contents(&state.sftp, &profile_id, &local_path, &remote_path, max_bytes).await
}

#[tauri::command]
pub async fn open_in_vscode(local_path: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || sftp::open_in_vscode(&local_path))
        .await
        .map_err(|e| crate::error::AppError::Config(format!("Join error: {}", e)))?
}

// ---------------------------------------------------------------------------
// Phase 3: Real-Time Local -> Remote Sync Engine Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn reconcile_workspace(
    app_handle: AppHandle,
    profile_id: String,
    dry_run: bool,
    state: State<'_, AppState>,
) -> AppResult<ReconcileReport> {
    state
        .sync
        .reconcile_workspace(&app_handle, &profile_id, dry_run)
        .await
}

#[tauri::command]
pub async fn sync_get_status(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<SyncStatusPayload> {
    state.sync.get_status(&profile_id).await
}

#[tauri::command]
pub async fn sync_update_policy(
    app_handle: AppHandle,
    profile_id: String,
    auto_sync_enabled: bool,
    crlf_guard_enabled: bool,
    sync_deletions: bool,
    state: State<'_, AppState>,
) -> AppResult<SyncStatusPayload> {
    state
        .sync
        .update_policy(
            &app_handle,
            &profile_id,
            auto_sync_enabled,
            crlf_guard_enabled,
            sync_deletions,
        )
        .await
}

#[tauri::command]
pub async fn sync_retry(profile_id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.sync.retry_sync(&profile_id).await
}

#[tauri::command]
pub async fn sync_get_activity_log(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<SyncBatchLogEntry>> {
    Ok(state.sync.get_activity_log(&profile_id).await)
}

#[tauri::command]
pub async fn sync_clear_activity_log(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.sync.clear_activity_log(&profile_id).await;
    Ok(())
}

#[tauri::command]
pub async fn sync_flush_pending(
    profile_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.sync.flush_pending_sync(&profile_id).await
}

// ---------------------------------------------------------------------------
// Phase 4: Per-Profile Macros & Workspace UI State Persistence
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn profile_update_macros(
    profile_id: String,
    macros: Vec<ProfileMacro>,
    state: State<'_, AppState>,
) -> AppResult<WorkspaceProfile> {
    tokio::task::spawn_blocking({
        let config = Arc::clone(&state.config);
        move || config.update_profile_macros(&profile_id, macros)
    })
    .await
    .map_err(|e| crate::error::AppError::Config(format!("Join error: {}", e)))?
}

#[tauri::command]
pub async fn ui_state_get(state: State<'_, AppState>) -> AppResult<WorkspaceUiState> {
    state.config.get_ui_state()
}

#[tauri::command]
pub async fn ui_state_save(
    ui_state: WorkspaceUiState,
    state: State<'_, AppState>,
) -> AppResult<WorkspaceUiState> {
    tokio::task::spawn_blocking({
        let config = Arc::clone(&state.config);
        move || config.save_ui_state(ui_state)
    })
    .await
    .map_err(|e| crate::error::AppError::Config(format!("Join error: {}", e)))?
}
