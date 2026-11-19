import React, { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  GitBranch,
  History,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { SyncActivityPopover } from "./SyncActivityPopover";
import { ReconcileModal } from "./ReconcileModal";
import type {
  ReconcileReport,
  SyncBatchLogEntry,
  SyncStatusPayload,
  WorkspaceProfile,
} from "../../types/labbridge";

interface SyncControlBarProps {
  profile: WorkspaceProfile | null;
  isConnected: boolean;
  syncStatus: SyncStatusPayload | null;
  activityLog: SyncBatchLogEntry[];
  reconcileBusy: boolean;
  reconcileReport: ReconcileReport | null;
  onCloseReconcileReport: () => void;
  onTogglePolicy: (
    autoSyncEnabled: boolean,
    crlfGuardEnabled: boolean,
    syncDeletions: boolean,
  ) => void;
  onRunReconcile: (dryRun: boolean) => void;
  onRetrySync: () => void;
  onClearActivityLog: () => void;
}

export const SyncControlBar: React.FC<SyncControlBarProps> = ({
  profile,
  isConnected,
  syncStatus,
  activityLog,
  reconcileBusy,
  reconcileReport,
  onCloseReconcileReport,
  onTogglePolicy,
  onRunReconcile,
  onRetrySync,
  onClearActivityLog,
}) => {
  const [activityOpen, setActivityOpen] = useState(false);
  const [confirmDeletionsOpen, setConfirmDeletionsOpen] = useState(false);

  const autoSync =
    syncStatus?.auto_sync_enabled ?? profile?.auto_sync_enabled ?? true;
  const crlfGuard =
    syncStatus?.crlf_guard_enabled ?? profile?.crlf_guard_enabled ?? true;
  const syncDeletions =
    syncStatus?.sync_deletions ?? profile?.sync_deletions ?? false;

  const hasValidPaths = Boolean(
    profile?.local_root_path?.trim() && profile?.remote_root_path?.trim(),
  );
  const canOperate = Boolean(profile && isConnected && hasValidPaths);

  const renderStatusPill = () => {
    if (!profile) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-950 border border-zinc-800 text-zinc-500">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
          <span>No Profile</span>
        </span>
      );
    }

    if (!hasValidPaths) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-950 border border-zinc-800 text-zinc-500">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
          <span>Set Local &amp; Remote Roots to Enable Sync</span>
        </span>
      );
    }

    if (!isConnected) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-950 border border-zinc-800 text-zinc-500">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
          <span>{autoSync ? "Standby (Offline)" : "Paused"}</span>
        </span>
      );
    }

    const st = syncStatus?.status ?? { kind: "idle", last_synced_ms: null };

    switch (st.kind) {
      case "paused":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-950/35 border border-amber-800/70 text-amber-300">
            <Pause className="w-3 h-3" />
            <span>
              Paused
              {st.buffered_files > 0 ? ` (${st.buffered_files} queued)` : ""}
            </span>
          </span>
        );

      case "waiting_on_git_lock":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-950/50 border border-amber-600/80 text-amber-200 animate-pulse">
            <GitBranch className="w-3 h-3 text-amber-400" />
            <span>
              Waiting on Git lock...
              {st.buffered_files > 0 ? ` (${st.buffered_files} held)` : ""}
            </span>
          </span>
        );

      case "syncing": {
        const stratLabel =
          st.strategy === "TAR Stream"
            ? "tar.gz"
            : st.strategy === "SFTP Atomic"
              ? "SFTP"
              : "rm -f";
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-cyan-950/50 border border-cyan-700/80 text-cyan-200">
            <RefreshCw className="w-3 h-3 text-cyan-400 animate-spin" />
            <span>
              {st.file_count > 0
                ? `Syncing ${st.file_count} ${
                    st.file_count === 1 ? "file" : "files"
                  } (${stratLabel})...`
                : `Reconciling workspace (${stratLabel})...`}
            </span>
          </span>
        );
      }

      case "error":
        return (
          <div className="inline-flex items-center gap-1.5">
            <span
              title={st.message}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-rose-950/60 border border-rose-700/80 text-rose-200 max-w-[300px] truncate"
            >
              <AlertTriangle className="w-3 h-3 text-rose-400 shrink-0" />
              <span className="truncate">Error: {st.message}</span>
            </span>
            <button
              type="button"
              onClick={onRetrySync}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-700 hover:bg-rose-600 text-white text-[10px] font-semibold"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Retry</span>
            </button>
          </div>
        );

      case "idle":
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-950/35 border border-emerald-800/70 text-emerald-300">
            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
            <span>Idle (Synced)</span>
          </span>
        );
    }
  };

  return (
    <>
      <div className="h-9 shrink-0 bg-zinc-950 border-b border-zinc-800 px-3 flex items-center justify-between gap-2 font-mono text-[11px] select-none">
        {/* Left: Live Sync Engine Status Pill */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold hidden sm:inline">
            SYNC ENGINE
          </span>
          {renderStatusPill()}
        </div>

        {/* Right: Sync Policy & Reconcile Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Auto-Sync Pause / Resume Toggle */}
          <button
            type="button"
            disabled={!profile}
            onClick={() => onTogglePolicy(!autoSync, crlfGuard, syncDeletions)}
            title={
              autoSync
                ? "Pause Real-Time Local -> Remote Auto-Sync"
                : "Resume Real-Time Local -> Remote Auto-Sync"
            }
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border transition-colors disabled:opacity-40 ${
              autoSync
                ? "border-emerald-800/80 bg-emerald-950/40 hover:bg-emerald-900/40 text-emerald-200"
                : "border-amber-800/80 bg-amber-950/40 hover:bg-amber-900/40 text-amber-200"
            }`}
          >
            {autoSync ? (
              <>
                <Pause className="w-3 h-3" />
                <span>Auto-Sync: ON</span>
              </>
            ) : (
              <>
                <Play className="w-3 h-3" />
                <span>Resume Sync</span>
              </>
            )}
          </button>

          {/* Force Reconcile: Check Dry-Run & Push Diff */}
          <div className="inline-flex items-center rounded border border-zinc-800 overflow-hidden bg-zinc-900">
            <button
              type="button"
              disabled={!canOperate || reconcileBusy}
              onClick={() => onRunReconcile(true)}
              title="Compare Local SHA-256 vs Remote sha256sum without modifying remote files"
              className="inline-flex items-center gap-1 px-2 py-0.5 hover:bg-zinc-800 disabled:opacity-35 disabled:pointer-events-none text-zinc-300 border-r border-zinc-800"
            >
              <FileCheck2 className="w-3 h-3 text-cyan-400" />
              <span>Check Dry-Run</span>
            </button>
            <button
              type="button"
              disabled={!canOperate || reconcileBusy}
              onClick={() => onRunReconcile(false)}
              title="Force Reconcile & Push Mismatched/Missing Files via tar.gz Stream"
              className="inline-flex items-center gap-1 px-2 py-0.5 hover:bg-zinc-800 disabled:opacity-35 disabled:pointer-events-none text-emerald-300"
            >
              <UploadCloud className="w-3 h-3 text-emerald-400" />
              <span>Push Diff</span>
            </button>
          </div>

          {/* CRLF Guard Toggle */}
          <button
            type="button"
            disabled={!profile}
            onClick={() => onTogglePolicy(autoSync, !crlfGuard, syncDeletions)}
            title="Convert CRLF -> LF in memory during upload for scripts (.sh, .py, Makefile, Kconfig) without modifying local Windows files"
            className={`hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded border transition-colors disabled:opacity-40 ${
              crlfGuard
                ? "border-cyan-800/70 bg-cyan-950/35 text-cyan-300"
                : "border-zinc-800 bg-slate-950 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <span>CRLF Guard: {crlfGuard ? "ON" : "OFF"}</span>
          </button>

          {/* Sync Deletions Toggle (with safety confirmation) */}
          <button
            type="button"
            disabled={!profile}
            onClick={() => {
              if (!syncDeletions) {
                setConfirmDeletionsOpen(true);
              } else {
                onTogglePolicy(autoSync, crlfGuard, false);
              }
            }}
            title="Propagate local file deletions to remote via batched SSH rm -f"
            className={`hidden lg:inline-flex items-center gap-1 px-2 py-0.5 rounded border transition-colors disabled:opacity-40 ${
              syncDeletions
                ? "border-rose-700/80 bg-rose-950/45 text-rose-300"
                : "border-zinc-800 bg-slate-950 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <Trash2 className="w-3 h-3" />
            <span>Deletions: {syncDeletions ? "ON" : "OFF"}</span>
          </button>

          {/* Activity Log Popover Trigger */}
          <button
            type="button"
            onClick={() => setActivityOpen((v) => !v)}
            title="View Last 200 Real-Time Sync Batches"
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border transition-colors ${
              activityOpen
                ? "border-emerald-600 bg-zinc-800 text-emerald-300"
                : "border-zinc-800 bg-slate-950 hover:bg-zinc-900 text-zinc-300"
            }`}
          >
            <History className="w-3 h-3 text-emerald-400" />
            <span>Log ({activityLog.length})</span>
          </button>
        </div>
      </div>

      {/* Safety Confirmation Modal for Sync Deletions */}
      {confirmDeletionsOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md bg-zinc-900 border border-rose-700/80 rounded shadow-2xl overflow-hidden font-mono text-xs"
          >
            <div className="px-4 py-2.5 bg-rose-950/50 border-b border-rose-800/70 flex items-center gap-2 text-rose-200 font-semibold uppercase">
              <AlertTriangle className="w-4 h-4 text-rose-400" />
              <span>Enable Remote Deletion Sync?</span>
            </div>
            <div className="p-4 space-y-2 text-zinc-300 leading-relaxed">
              <p>
                When <span className="text-rose-300">Sync Deletions</span> is
                enabled, deleting or renaming non-ignored source files locally
                will execute batched <code className="text-rose-200">rm -f</code>{" "}
                commands on the remote Linux workspace.
              </p>
              <p className="text-[11px] text-zinc-400">
                Ignored build folders (<code>.gitignore</code>,{" "}
                <code>.labignore</code>, <code>build/</code>,{" "}
                <code>target/</code>) remain protected and are never deleted.
              </p>
            </div>
            <div className="px-4 py-2.5 bg-zinc-950 border-t border-zinc-800 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeletionsOpen(false)}
                className="px-3 py-1 rounded border border-zinc-700 bg-zinc-900 text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDeletionsOpen(false);
                  onTogglePolicy(autoSync, crlfGuard, true);
                }}
                className="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white font-semibold"
              >
                Enable Sync Deletions
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Real-Time Sync Activity Log Popover */}
      <SyncActivityPopover
        isOpen={activityOpen}
        entries={activityLog}
        onClose={() => setActivityOpen(false)}
        onClear={onClearActivityLog}
      />

      {/* Reconcile Dry-Run / Diff Modal */}
      <ReconcileModal
        report={reconcileReport}
        syncDeletionsEnabled={syncDeletions}
        isBusy={reconcileBusy}
        onClose={onCloseReconcileReport}
        onRerunDryRun={() => onRunReconcile(true)}
        onPushDiff={() => {
          onCloseReconcileReport();
          onRunReconcile(false);
        }}
      />
    </>
  );
};
