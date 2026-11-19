import React, { useEffect } from "react";
import { CheckCircle2, FolderSync, RefreshCw, UploadCloud, X } from "lucide-react";
import { formatBytes } from "../explorer/formatters";
import type { ReconcileReport } from "../../types/labbridge";

interface ReconcileModalProps {
  report: ReconcileReport | null;
  syncDeletionsEnabled: boolean;
  isBusy: boolean;
  onClose: () => void;
  onRerunDryRun: () => void;
  onPushDiff: () => void;
}

export const ReconcileModal: React.FC<ReconcileModalProps> = ({
  report,
  syncDeletionsEnabled,
  isBusy,
  onClose,
  onRerunDryRun,
  onPushDiff,
}) => {
  useEffect(() => {
    if (!report) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [report, onClose]);

  if (!report) return null;

  const totalToPush =
    report.missing_on_remote.length + report.modified_files.length;
  const totalDeletions = syncDeletionsEnabled
    ? report.remote_only_files.length
    : 0;
  const inSync = totalToPush === 0 && totalDeletions === 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-2xl max-h-[82vh] bg-zinc-900 border border-zinc-800 rounded shadow-2xl flex flex-col overflow-hidden font-mono text-xs"
      >
        {/* Header */}
        <div className="h-10 px-4 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <FolderSync className="w-4 h-4 text-emerald-400" />
            <span className="font-semibold uppercase tracking-wider text-zinc-100">
              {report.dry_run
                ? "Workspace Reconcile — Dry-Run Report"
                : "Workspace Reconcile — Completed"}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Summary Metrics */}
        <div className="p-4 space-y-3 overflow-y-auto flex-1 bg-slate-950">
          <div className="grid grid-cols-4 gap-2 text-[11px]">
            <div className="bg-zinc-900 border border-zinc-800 rounded p-2">
              <div className="text-[10px] text-zinc-500 uppercase">
                Missing Remote
              </div>
              <div className="text-emerald-300 font-semibold mt-0.5">
                {report.missing_on_remote.length} files
              </div>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 rounded p-2">
              <div className="text-[10px] text-zinc-500 uppercase">
                SHA-256 Changed
              </div>
              <div className="text-amber-300 font-semibold mt-0.5">
                {report.modified_files.length} files
              </div>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 rounded p-2">
              <div className="text-[10px] text-zinc-500 uppercase">
                Identical
              </div>
              <div className="text-zinc-200 font-semibold mt-0.5">
                {report.identical_count} files
              </div>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 rounded p-2">
              <div className="text-[10px] text-zinc-500 uppercase">
                Scan Duration
              </div>
              <div className="text-zinc-200 font-semibold mt-0.5">
                {report.duration_ms}ms ({formatBytes(report.total_upload_bytes)})
              </div>
            </div>
          </div>

          {inSync ? (
            <div className="p-4 rounded bg-emerald-950/30 border border-emerald-800/60 flex items-center gap-2.5 text-emerald-200">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>
                Local and Remote workspaces are 100% synchronized (SHA-256
                verified with active CRLF policy).
              </span>
            </div>
          ) : (
            <div className="space-y-3">
              {report.missing_on_remote.length > 0 && (
                <div className="bg-zinc-900 border border-zinc-800 rounded p-2.5">
                  <div className="text-[10px] uppercase text-emerald-400 mb-1.5">
                    New / Missing on Remote ({report.missing_on_remote.length})
                  </div>
                  <div className="max-h-32 overflow-y-auto space-y-0.5 text-[11px] text-zinc-300">
                    {report.missing_on_remote.map((f) => (
                      <div key={f} className="truncate">
                        + {f}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {report.modified_files.length > 0 && (
                <div className="bg-zinc-900 border border-zinc-800 rounded p-2.5">
                  <div className="text-[10px] uppercase text-amber-400 mb-1.5">
                    Modified SHA-256 Digest ({report.modified_files.length})
                  </div>
                  <div className="max-h-32 overflow-y-auto space-y-0.5 text-[11px] text-zinc-300">
                    {report.modified_files.map((f) => (
                      <div key={f} className="truncate">
                        ~ {f}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {report.remote_only_files.length > 0 && (
                <div className="bg-zinc-900 border border-zinc-800 rounded p-2.5">
                  <div className="text-[10px] uppercase text-rose-400 mb-1.5">
                    Remote-Only Non-Ignored Files (
                    {report.remote_only_files.length}) —{" "}
                    {syncDeletionsEnabled
                      ? "WILL BE REMOVED (Sync Deletions ON)"
                      : "PRESERVED (Sync Deletions OFF)"}
                  </div>
                  <div className="max-h-28 overflow-y-auto space-y-0.5 text-[11px] text-zinc-400">
                    {report.remote_only_files.map((f) => (
                      <div key={f} className="truncate">
                        {syncDeletionsEnabled ? "- " : "• "}
                        {f}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="h-11 px-4 bg-zinc-950 border-t border-zinc-800 flex items-center justify-between shrink-0">
          <button
            type="button"
            disabled={isBusy}
            onClick={onRerunDryRun}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-zinc-700 hover:bg-zinc-800 disabled:opacity-40 text-zinc-300"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isBusy ? "animate-spin" : ""}`} />
            <span>Re-check Dry-Run</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 rounded border border-zinc-800 hover:border-zinc-700 text-zinc-300"
            >
              Close
            </button>
            {report.dry_run && !inSync && (
              <button
                type="button"
                disabled={isBusy}
                onClick={onPushDiff}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-slate-950 font-semibold"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                <span>
                  Push Diff ({totalToPush}{" "}
                  {totalToPush === 1 ? "file" : "files"} via tar.gz)
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
