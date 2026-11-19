import React, { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Trash2,
  X,
} from "lucide-react";
import { formatBytes } from "../explorer/formatters";
import type { SyncBatchLogEntry } from "../../types/labbridge";

interface SyncActivityPopoverProps {
  isOpen: boolean;
  entries: SyncBatchLogEntry[];
  onClose: () => void;
  onClear: () => void;
}

function formatBatchTimestamp(epochMs: number): string {
  const dt = new Date(epochMs);
  if (Number.isNaN(dt.getTime())) return "—";
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(
    dt.getSeconds(),
  )}.${pad(dt.getMilliseconds(), 3)}`;
}

export const SyncActivityPopover: React.FC<SyncActivityPopoverProps> = ({
  isOpen,
  entries,
  onClose,
  onClear,
}) => {
  const popRef = useRef<HTMLDivElement | null>(null);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (ev: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(ev.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div
      ref={popRef}
      className="fixed top-20 right-3 z-50 w-[560px] max-w-[94vw] max-h-[72vh] bg-zinc-900 border border-zinc-700 rounded shadow-2xl flex flex-col overflow-hidden font-mono text-xs"
    >
      {/* Header */}
      <div className="h-9 px-3 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Clock className="w-3.5 h-3.5 text-emerald-400" />
          <span className="font-semibold uppercase tracking-wider text-zinc-100 text-[11px]">
            Real-Time Sync Activity Log ({entries.length}/200)
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {entries.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-zinc-800 hover:border-zinc-700 bg-zinc-900 text-[10px] text-zinc-300"
            >
              <Trash2 className="w-3 h-3" />
              <span>Clear</span>
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Scrollable Batch List */}
      <div className="flex-1 overflow-y-auto divide-y divide-zinc-800/80 bg-slate-950">
        {entries.length === 0 ? (
          <div className="py-10 px-4 text-center text-zinc-500 text-xs">
            No sync batches recorded in this session yet. Save files in VS Code
            or run Force Reconcile to populate live telemetry.
          </div>
        ) : (
          entries.map((batch) => {
            const expanded = Boolean(expandedIds[batch.id]);
            const strategyBadgeClass =
              batch.strategy === "SFTP Atomic"
                ? "border-emerald-800/80 bg-emerald-950/50 text-emerald-300"
                : batch.strategy === "TAR Stream"
                  ? "border-cyan-800/80 bg-cyan-950/50 text-cyan-300"
                  : "border-amber-800/80 bg-amber-950/50 text-amber-300";

            return (
              <div key={batch.id} className="p-2.5 space-y-1.5">
                <div
                  onClick={() => toggleExpand(batch.id)}
                  className="flex items-center justify-between gap-2 cursor-pointer"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {expanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    )}

                    {batch.success ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                    )}

                    <span className="text-[11px] text-zinc-400 shrink-0">
                      {formatBatchTimestamp(batch.timestamp_ms)}
                    </span>

                    <span
                      className={`px-1.5 py-0.5 rounded border text-[10px] shrink-0 ${strategyBadgeClass}`}
                    >
                      {batch.strategy}
                    </span>

                    <span className="text-[11px] text-zinc-200 truncate">
                      {batch.files.length}{" "}
                      {batch.files.length === 1 ? "file" : "files"}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 text-[11px]">
                    {batch.crlf_converted_count > 0 && (
                      <span
                        title="Files converted CRLF -> LF in memory"
                        className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[10px] text-amber-300"
                      >
                        {batch.crlf_converted_count} LF
                      </span>
                    )}
                    <span className="text-zinc-500">
                      {formatBytes(batch.bytes_transferred)}
                    </span>
                    <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                      {batch.duration_ms}ms
                    </span>
                  </div>
                </div>

                {batch.error && (
                  <div className="pl-6 text-[11px] text-rose-400 break-words">
                    {batch.error}
                  </div>
                )}

                {/* Preview top 2 files when collapsed, full list when expanded */}
                {!expanded && batch.files.length > 0 && (
                  <div className="pl-6 text-[10px] text-zinc-500 truncate">
                    {batch.files.slice(0, 3).join(", ")}
                    {batch.files.length > 3
                      ? ` (+${batch.files.length - 3} more)`
                      : ""}
                  </div>
                )}

                {expanded && batch.files.length > 0 && (
                  <div className="ml-6 mt-1 p-2 rounded bg-zinc-900/90 border border-zinc-800 max-h-40 overflow-y-auto space-y-0.5 text-[11px]">
                    {batch.files.map((f, i) => (
                      <div
                        key={i}
                        className={
                          f.startsWith("- ")
                            ? "text-rose-300 truncate"
                            : "text-zinc-300 truncate"
                        }
                      >
                        {f}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
