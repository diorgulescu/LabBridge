import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  ConnectionStatusPayload,
  DiffContentsResponse,
  DirListing,
  FileHashComparison,
  HostKeyPromptPayload,
  KnownHostEntry,
  ProfileMacro,
  PtyClosedPayload,
  ReconcileReport,
  SecretStatus,
  StorageInfo,
  SyncBatchLogEntry,
  SyncStatusPayload,
  TransferDirection,
  TransferProgressEvent,
  WorkspaceProfile,
  WorkspaceUiState,
} from "../types/labbridge";

/**
 * Normalizes Windows `\` separators into strict POSIX `/` paths for remote Linux targets.
 */
export function normalizePosixPath(input: string): string {
  if (!input) return "";
  const unified = input.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (unified.length > 1 && unified.endsWith("/")) {
    return unified.slice(0, -1);
  }
  return unified;
}

/**
 * Joins a remote base path and child segment using strict POSIX `/` separators.
 */
export function joinPosixPath(base: string, child: string): string {
  const cleanChild = child.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const cleanBase = normalizePosixPath(base || "/");
  if (!cleanChild) return cleanBase;
  if (cleanBase === "/") return `/${cleanChild}`;
  return `${cleanBase}/${cleanChild}`;
}

/**
 * Joins a local directory path and child name preserving Windows `\` or POSIX `/` style.
 */
export function joinLocalPath(base: string, child: string): string {
  const isWin = base.includes("\\") || /^[A-Za-z]:/.test(base);
  const sep = isWin ? "\\" : "/";
  const trimmedBase =
    base.endsWith("\\") || base.endsWith("/") ? base.slice(0, -1) : base;
  const cleanChild = child.replace(/^[\\/]+/, "");
  if (isWin && /^[A-Za-z]:$/.test(trimmedBase)) {
    return `${trimmedBase}\\${cleanChild}`;
  }
  return `${trimmedBase}${sep}${cleanChild}`;
}

export function formatError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// Storage, Profiles & Known Hosts IPC
// ---------------------------------------------------------------------------

export async function getStorageInfo(): Promise<StorageInfo> {
  return invoke<StorageInfo>("storage_get_info");
}

export async function listProfiles(): Promise<WorkspaceProfile[]> {
  return invoke<WorkspaceProfile[]>("profiles_list");
}

export async function saveProfile(
  profile: WorkspaceProfile,
  targetSecret: string | null,
  proxySecret: string | null,
): Promise<WorkspaceProfile> {
  return invoke<WorkspaceProfile>("profile_save", {
    profile,
    targetSecret: targetSecret && targetSecret.length > 0 ? targetSecret : null,
    proxySecret: proxySecret && proxySecret.length > 0 ? proxySecret : null,
  });
}

export async function duplicateProfile(
  profileId: string,
): Promise<WorkspaceProfile> {
  return invoke<WorkspaceProfile>("profile_duplicate", { profileId });
}

export async function deleteProfile(profileId: string): Promise<void> {
  return invoke<void>("profile_delete", { profileId });
}

export async function getProfileSecretStatus(
  profileId: string,
): Promise<SecretStatus> {
  return invoke<SecretStatus>("profile_secret_status", { profileId });
}

export async function listKnownHosts(): Promise<KnownHostEntry[]> {
  return invoke<KnownHostEntry[]>("known_hosts_list");
}

export async function removeKnownHost(
  hostId: string,
  algorithm: string,
): Promise<void> {
  return invoke<void>("known_hosts_remove", { hostId, algorithm });
}

// ---------------------------------------------------------------------------
// Native File & Folder Dialogs (tauri-plugin-dialog)
// ---------------------------------------------------------------------------

export async function browseLocalFolder(
  defaultPath?: string,
): Promise<string | null> {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title: "Select Local Workspace Directory",
    defaultPath: defaultPath || undefined,
  });
  return typeof selected === "string" ? selected : null;
}

export async function browseSshKeyFile(
  defaultPath?: string,
): Promise<string | null> {
  const selected = await openDialog({
    directory: false,
    multiple: false,
    title: "Select SSH Private Key File",
    defaultPath: defaultPath || undefined,
  });
  return typeof selected === "string" ? selected : null;
}

// ---------------------------------------------------------------------------
// Multiplexed SSH Engine IPC
// ---------------------------------------------------------------------------

export async function sshConnect(
  profileId: string,
): Promise<ConnectionStatusPayload> {
  return invoke<ConnectionStatusPayload>("ssh_connect", { profileId });
}

export async function sshDisconnect(
  profileId: string,
): Promise<ConnectionStatusPayload> {
  return invoke<ConnectionStatusPayload>("ssh_disconnect", { profileId });
}

export async function sshGetState(
  profileId: string,
): Promise<ConnectionStatusPayload> {
  return invoke<ConnectionStatusPayload>("ssh_get_state", { profileId });
}

export async function sshListStates(): Promise<
  Record<string, ConnectionStatusPayload>
> {
  return invoke<Record<string, ConnectionStatusPayload>>("ssh_list_states");
}

export async function sshRespondHostKey(
  requestId: string,
  accept: boolean,
): Promise<void> {
  return invoke<void>("ssh_respond_host_key", { requestId, accept });
}

// ---------------------------------------------------------------------------
// Multiplexed PTY Manager IPC (Binary Channel<Vec<u8>>)
// ---------------------------------------------------------------------------

export type PtyChunkPayload = number[] | Uint8Array | ArrayBuffer;

export async function ptyOpen(
  profileId: string,
  cols: number,
  rows: number,
  onChunk: (bytes: Uint8Array) => void,
): Promise<string> {
  const onData = new Channel<PtyChunkPayload>();
  onData.onmessage = (payload) => {
    let bytes: Uint8Array | null = null;
    if (payload instanceof Uint8Array) {
      bytes = payload;
    } else if (payload instanceof ArrayBuffer) {
      bytes = new Uint8Array(payload);
    } else if (Array.isArray(payload)) {
      bytes = new Uint8Array(payload);
    }
    if (bytes && bytes.length > 0) {
      onChunk(bytes);
    }
  };

  return invoke<string>("pty_open", {
    profileId,
    cols: Math.max(10, Math.floor(cols)),
    rows: Math.max(4, Math.floor(rows)),
    onData,
  });
}

export async function ptyWrite(
  tabId: string,
  bytes: Uint8Array,
): Promise<void> {
  // Tauri v2 natively supports Uint8Array over invoke — uses binary IPC
  // instead of JSON-serializing each byte as a number (Array.from).
  return invoke<void>("pty_write", {
    tabId,
    data: bytes,
  });
}

export async function ptyResize(
  tabId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("pty_resize", {
    tabId,
    cols: Math.max(10, Math.floor(cols)),
    rows: Math.max(4, Math.floor(rows)),
  });
}

export async function ptyClose(tabId: string): Promise<void> {
  return invoke<void>("pty_close", { tabId });
}

// ---------------------------------------------------------------------------
// Backend Event Subscriptions
// ---------------------------------------------------------------------------

export function onSshStateChanged(
  handler: (payload: ConnectionStatusPayload) => void,
): Promise<UnlistenFn> {
  return listen<ConnectionStatusPayload>("ssh:state-changed", (ev) =>
    handler(ev.payload),
  );
}

export function onHostKeyVerify(
  handler: (payload: HostKeyPromptPayload) => void,
): Promise<UnlistenFn> {
  return listen<HostKeyPromptPayload>("ssh:host-key-verify", (ev) =>
    handler(ev.payload),
  );
}

export function onPtyClosed(
  handler: (payload: PtyClosedPayload) => void,
): Promise<UnlistenFn> {
  return listen<PtyClosedPayload>("pty:closed", (ev) => handler(ev.payload));
}

// ---------------------------------------------------------------------------
// Phase 2: Local & Remote SFTP Filesystem IPC
// ---------------------------------------------------------------------------

export async function fsLocalListDir(path?: string): Promise<DirListing> {
  return invoke<DirListing>("fs_local_list_dir", {
    path: path && path.trim().length > 0 ? path : null,
  });
}

export async function fsLocalCreateDir(path: string): Promise<void> {
  return invoke<void>("fs_local_create_dir", { path });
}

export async function fsLocalRename(
  oldPath: string,
  newPath: string,
): Promise<void> {
  return invoke<void>("fs_local_rename", { oldPath, newPath });
}

export async function fsLocalDelete(path: string): Promise<void> {
  return invoke<void>("fs_local_delete", { path });
}

export async function sftpListDir(
  profileId: string,
  path?: string,
): Promise<DirListing> {
  return invoke<DirListing>("sftp_list_dir", {
    profileId,
    path: path && path.trim().length > 0 ? normalizePosixPath(path) : null,
  });
}

export async function sftpCreateDir(
  profileId: string,
  path: string,
): Promise<void> {
  return invoke<void>("sftp_create_dir", {
    profileId,
    path: normalizePosixPath(path),
  });
}

export async function sftpRename(
  profileId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  return invoke<void>("sftp_rename", {
    profileId,
    oldPath: normalizePosixPath(oldPath),
    newPath: normalizePosixPath(newPath),
  });
}

export async function sftpDelete(
  profileId: string,
  path: string,
  recursive = true,
): Promise<void> {
  return invoke<void>("sftp_delete", {
    profileId,
    path: normalizePosixPath(path),
    recursive,
  });
}

export async function sftpChmod(
  profileId: string,
  path: string,
  mode: number,
): Promise<void> {
  return invoke<void>("sftp_chmod", {
    profileId,
    path: normalizePosixPath(path),
    mode: mode & 0o7777,
  });
}

// ---------------------------------------------------------------------------
// Phase 2: Async Transfer Queue IPC (Channel<TransferProgressEvent>)
// ---------------------------------------------------------------------------

export async function transferSubscribe(
  onEvent: (event: TransferProgressEvent) => void,
): Promise<void> {
  const onProgress = new Channel<TransferProgressEvent>();
  onProgress.onmessage = (payload) => {
    onEvent(payload);
  };
  return invoke<void>("transfer_subscribe", { onProgress });
}

export async function transferEnqueue(
  profileId: string,
  direction: TransferDirection,
  sourcePath: string,
  destPath: string,
): Promise<TransferProgressEvent> {
  return invoke<TransferProgressEvent>("transfer_enqueue", {
    profileId,
    direction,
    sourcePath:
      direction === "download" ? normalizePosixPath(sourcePath) : sourcePath,
    destPath:
      direction === "upload" ? normalizePosixPath(destPath) : destPath,
  });
}

export async function transferCancel(transferId: string): Promise<void> {
  return invoke<void>("transfer_cancel", { transferId });
}

export async function transferList(): Promise<TransferProgressEvent[]> {
  return invoke<TransferProgressEvent[]>("transfer_list");
}

export async function transferClearFinished(): Promise<void> {
  return invoke<void>("transfer_clear_finished");
}

// ---------------------------------------------------------------------------
// Phase 2: Quick Diff & External VS Code Launch IPC
// ---------------------------------------------------------------------------

export async function compareFileHashes(
  profileId: string,
  localPath: string,
  remotePath: string,
): Promise<FileHashComparison> {
  return invoke<FileHashComparison>("compare_file_hashes", {
    profileId,
    localPath,
    remotePath: normalizePosixPath(remotePath),
  });
}

export async function diffReadContents(
  profileId: string,
  localPath: string,
  remotePath: string,
  maxBytes?: number,
): Promise<DiffContentsResponse> {
  return invoke<DiffContentsResponse>("diff_read_contents", {
    profileId,
    localPath,
    remotePath: normalizePosixPath(remotePath),
    maxBytes: maxBytes ?? null,
  });
}

export async function openInVscode(localPath: string): Promise<void> {
  return invoke<void>("open_in_vscode", { localPath });
}

// ---------------------------------------------------------------------------
// Phase 3: Real-Time Local -> Remote Sync Engine IPC
// ---------------------------------------------------------------------------

export async function reconcileWorkspace(
  profileId: string,
  dryRun: boolean,
): Promise<ReconcileReport> {
  return invoke<ReconcileReport>("reconcile_workspace", { profileId, dryRun });
}

export async function syncGetStatus(
  profileId: string,
): Promise<SyncStatusPayload> {
  return invoke<SyncStatusPayload>("sync_get_status", { profileId });
}

export async function syncUpdatePolicy(
  profileId: string,
  autoSyncEnabled: boolean,
  crlfGuardEnabled: boolean,
  syncDeletions: boolean,
): Promise<SyncStatusPayload> {
  return invoke<SyncStatusPayload>("sync_update_policy", {
    profileId,
    autoSyncEnabled,
    crlfGuardEnabled,
    syncDeletions,
  });
}

export async function syncRetry(profileId: string): Promise<void> {
  return invoke<void>("sync_retry", { profileId });
}

export async function syncGetActivityLog(
  profileId: string,
): Promise<SyncBatchLogEntry[]> {
  return invoke<SyncBatchLogEntry[]>("sync_get_activity_log", { profileId });
}

export async function syncClearActivityLog(profileId: string): Promise<void> {
  return invoke<void>("sync_clear_activity_log", { profileId });
}

export function onSyncStatusChanged(
  handler: (payload: SyncStatusPayload) => void,
): Promise<UnlistenFn> {
  return listen<SyncStatusPayload>("sync:status-changed", (ev) =>
    handler(ev.payload),
  );
}

export function onSyncBatchLogged(
  handler: (payload: SyncBatchLogEntry) => void,
): Promise<UnlistenFn> {
  return listen<SyncBatchLogEntry>("sync:batch-logged", (ev) =>
    handler(ev.payload),
  );
}

export async function syncFlushPending(profileId: string): Promise<void> {
  return invoke<void>("sync_flush_pending", { profileId });
}

// ---------------------------------------------------------------------------
// Phase 4: Per-Profile Macros, OSC 7 & Workspace UI State Persistence
// ---------------------------------------------------------------------------

export async function profileUpdateMacros(
  profileId: string,
  macros: ProfileMacro[],
): Promise<WorkspaceProfile> {
  return invoke<WorkspaceProfile>("profile_update_macros", {
    profileId,
    macros,
  });
}

export async function uiStateGet(): Promise<WorkspaceUiState> {
  return invoke<WorkspaceUiState>("ui_state_get");
}

export async function uiStateSave(
  uiState: WorkspaceUiState,
): Promise<WorkspaceUiState> {
  return invoke<WorkspaceUiState>("ui_state_save", { uiState });
}

/**
 * Parses an OSC 7 payload (`file://hostname/path/to/dir` or `/path/to/dir`) into a POSIX directory path.
 */
export function parseOsc7RemotePath(data: string): string | null {
  const trimmed = data.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("file://")) {
    const rest = trimmed.slice("file://".length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1) return null;
    const rawPath = rest.slice(slashIdx);
    try {
      return normalizePosixPath(decodeURIComponent(rawPath));
    } catch {
      return normalizePosixPath(rawPath);
    }
  }

  if (trimmed.startsWith("/")) {
    return normalizePosixPath(trimmed);
  }
  return null;
}

/**
 * Bash & Zsh compatible prompt hook emitting OSC 7 (`\e]7;file://host/pwd\a`) on every prompt.
 * Leading space avoids polluting bash history when HISTCONTROL includes ignorespace/ignoreboth.
 */
export const OSC7_PROMPT_HOOK_SNIPPET =
  ' __lb_osc7() { printf "\\033]7;file://%s%s\\007" "${HOSTNAME:-localhost}" "$PWD"; }; if [ -n "${ZSH_VERSION:-}" ]; then precmd_functions+=(__lb_osc7); elif [ -n "${BASH_VERSION:-}" ]; then case ";${PROMPT_COMMAND:-};" in *";__lb_osc7;"*) ;; *) PROMPT_COMMAND="__lb_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;; esac; fi; __lb_osc7\n';
