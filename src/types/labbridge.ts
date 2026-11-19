export type AuthMethod =
  | {
      type: "PrivateKeyFile";
      path: string;
      passphrase_in_keyring: boolean;
    }
  | {
      type: "PasswordInKeyring";
    }
  | {
      type: "WindowsSshAgent";
    };

export interface ProxyJumpConfig {
  host: string;
  port: number;
  user: string;
  auth: AuthMethod;
}

export type MacroTargetMode = "active_terminal" | "dedicated_tab";

export type MacroAccent =
  | "emerald"
  | "cyan"
  | "amber"
  | "indigo"
  | "rose"
  | "zinc";

export interface ProfileMacro {
  id: string;
  label: string;
  command: string;
  accent: MacroAccent;
  target_mode: MacroTargetMode;
  flush_sync_before_run: boolean;
}

export interface WorkspaceProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: AuthMethod;
  proxy_jump: ProxyJumpConfig | null;
  local_root_path: string;
  remote_root_path: string;
  keepalive_secs: number;
  auto_sync_enabled?: boolean;
  crlf_guard_enabled?: boolean;
  sync_deletions?: boolean;
  excluded_dirs?: string[];
  macros?: ProfileMacro[];
}

export interface SecretStatus {
  has_target_secret: boolean;
  has_proxy_secret: boolean;
}

export interface StorageInfo {
  data_dir: string;
  is_portable: boolean;
  profiles_file: string;
  known_hosts_file: string;
  logs_dir: string;
}

export interface KnownHostEntry {
  host_id: string;
  algorithm: string;
  fingerprint_sha256: string;
}

export type KnownHostCheck =
  | { status: "Trusted" }
  | { status: "Unknown" }
  | { status: "Changed"; previous_fingerprint: string };

export interface HostKeyPromptPayload {
  request_id: string;
  profile_id: string;
  host: string;
  port: number;
  host_id: string;
  is_jump_host: boolean;
  key_algorithm: string;
  fingerprint_sha256: string;
  check_status: KnownHostCheck;
}

export type ConnectionState =
  | { state: "Disconnected" }
  | { state: "Connecting" }
  | { state: "Connected"; rtt_ms: number }
  | { state: "Reconnecting" };

export interface ConnectionStatusPayload {
  profile_id: string;
  connection_state: ConnectionState;
  message?: string | null;
  reconnect_attempt?: number | null;
}

export interface PtyClosedPayload {
  tab_id: string;
  profile_id: string;
  exit_code?: number | null;
}

export interface TerminalTabModel {
  uiId: string;
  ptyTabId: string | null;
  profileId: string;
  profileName: string;
  title: string;
  status: "opening" | "ready" | "disconnected" | "exited" | "error";
  exitCode?: number | null;
  errorMessage?: string;
  renderer: "webgl" | "canvas";
  cols: number;
  rows: number;
  macroId?: string;
  initialCommand?: string;
}

// ---------------------------------------------------------------------------
// Phase 2: Dual-Pane Explorer, Async Transfer Queue & Diff Types
// ---------------------------------------------------------------------------

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface FsEntry {
  name: string;
  path: string;
  kind: EntryKind;
  is_dir_like: boolean;
  size: number;
  mtime: number | null;
  permissions_octal: string | null;
  permissions_rwx: string | null;
  mode: number | null;
  is_executable: boolean;
}

export interface DirListing {
  path: string;
  parent_path: string | null;
  entries: FsEntry[];
}

export type TransferDirection = "upload" | "download";

export type TransferStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "failed";

export interface TransferProgressEvent {
  transfer_id: string;
  profile_id: string;
  direction: TransferDirection;
  file_name: string;
  source_path: string;
  dest_path: string;
  bytes_done: number;
  bytes_total: number;
  speed_bps: number;
  status: TransferStatus;
  error?: string | null;
}

export interface FileHashComparison {
  local_path: string;
  remote_path: string;
  local_sha256: string;
  remote_sha256: string;
  local_size: number;
  remote_size: number | null;
  matches: boolean;
}

export interface DiffContentsResponse {
  local_path: string;
  remote_path: string;
  local_text: string;
  remote_text: string;
  is_binary: boolean;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Phase 3: Real-Time Local -> Remote Sync Engine Types
// ---------------------------------------------------------------------------

export type SyncStrategy = "SFTP Atomic" | "TAR Stream" | "SSH rm -f";

export type SyncStatusState =
  | { kind: "inactive" }
  | { kind: "paused"; buffered_files: number }
  | { kind: "idle"; last_synced_ms: number | null }
  | { kind: "waiting_on_git_lock"; buffered_files: number }
  | { kind: "syncing"; file_count: number; strategy: SyncStrategy }
  | { kind: "error"; message: string };

export interface SyncStatusPayload {
  profile_id: string;
  status: SyncStatusState;
  auto_sync_enabled: boolean;
  crlf_guard_enabled: boolean;
  sync_deletions: boolean;
  local_root_path: string;
  remote_root_path: string;
}

export interface SyncBatchLogEntry {
  id: string;
  profile_id: string;
  timestamp_ms: number;
  strategy: SyncStrategy;
  duration_ms: number;
  files: string[];
  bytes_transferred: number;
  crlf_converted_count: number;
  deleted_count: number;
  success: boolean;
  error?: string | null;
}

export interface ReconcileReport {
  profile_id: string;
  dry_run: boolean;
  missing_on_remote: string[];
  modified_files: string[];
  remote_only_files: string[];
  identical_count: number;
  total_upload_bytes: number;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Phase 4: Persisted Workspace UI & Window Geometry State
// ---------------------------------------------------------------------------

export interface WindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface WorkspaceUiState {
  last_active_profile_id: string | null;
  explorer_left_ratio: number;
  terminal_dock_height: number;
  terminal_dock_maximized: boolean;
  follow_terminal_cwd: boolean;
  window?: WindowGeometry | null;
}

