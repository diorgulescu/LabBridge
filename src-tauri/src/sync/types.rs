use serde::{Deserialize, Serialize};

pub const EVENT_SYNC_STATUS_CHANGED: &str = "sync:status-changed";
pub const EVENT_SYNC_BATCH_LOGGED: &str = "sync:batch-logged";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SyncStrategy {
    #[serde(rename = "SFTP Atomic")]
    SftpAtomic,
    #[serde(rename = "TAR Stream")]
    TarStream,
    #[serde(rename = "SSH rm -f")]
    ExecDelete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SyncStatusState {
    Inactive,
    Paused {
        buffered_files: usize,
    },
    Idle {
        last_synced_ms: Option<u64>,
    },
    WaitingOnGitLock {
        buffered_files: usize,
    },
    Syncing {
        file_count: usize,
        strategy: SyncStrategy,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatusPayload {
    pub profile_id: String,
    pub status: SyncStatusState,
    pub auto_sync_enabled: bool,
    pub crlf_guard_enabled: bool,
    pub sync_deletions: bool,
    pub local_root_path: String,
    pub remote_root_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncBatchLogEntry {
    pub id: String,
    pub profile_id: String,
    pub timestamp_ms: u64,
    pub strategy: SyncStrategy,
    pub duration_ms: u64,
    pub files: Vec<String>,
    pub bytes_transferred: u64,
    pub crlf_converted_count: usize,
    pub deleted_count: usize,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconcileReport {
    pub profile_id: String,
    pub dry_run: bool,
    pub missing_on_remote: Vec<String>,
    pub modified_files: Vec<String>,
    pub remote_only_files: Vec<String>,
    pub identical_count: usize,
    pub total_upload_bytes: u64,
    pub duration_ms: u64,
}
