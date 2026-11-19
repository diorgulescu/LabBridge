use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub is_dir_like: bool,
    pub size: u64,
    pub mtime: Option<u64>,
    pub permissions_octal: Option<String>,
    pub permissions_rwx: Option<String>,
    pub mode: Option<u32>,
    pub is_executable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirListing {
    pub path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<FsEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStatus {
    Queued,
    InProgress,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgressEvent {
    pub transfer_id: String,
    pub profile_id: String,
    pub direction: TransferDirection,
    pub file_name: String,
    pub source_path: String,
    pub dest_path: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub speed_bps: u64,
    pub status: TransferStatus,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileHashComparison {
    pub local_path: String,
    pub remote_path: String,
    pub local_sha256: String,
    pub remote_sha256: String,
    pub local_size: u64,
    pub remote_size: Option<u64>,
    pub matches: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffContentsResponse {
    pub local_path: String,
    pub remote_path: String,
    pub local_text: String,
    pub remote_text: String,
    pub is_binary: bool,
    pub truncated: bool,
}
