import React from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Trash2,
  XCircle,
} from "lucide-react";
import { formatBytes, formatThroughputMBps } from "./formatters";
import type { TransferProgressEvent } from "../../types/labbridge";

interface TransferDrawerProps {
  transfers: TransferProgressEvent[];
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onCancelTransfer: (transferId: string) => void;
  onClearFinished: () => void;
}

export const TransferDrawer: React.FC<TransferDrawerProps> = ({
  transfers,
  isExpanded,
  onToggleExpanded,
  onCancelTransfer,
  onClearFinished,
}) => {
  const activeCount = transfers.filter(
    (t) => t.status === "in_progress" || t.status === "queued",
  ).length;

  const finishedCount = transfers.length - activeCount;

  const totalSpeedBps = transfers
    .filter((t) => t.status === "in_progress")
    .reduce((acc, t) => acc + t.speed_bps, 0);

  return (
    <div className="shrink-0 bg-zinc-900 border-t border-zinc-800 flex flex-col font-mono text-xs">
      {/* Collapsible Header Bar */}
      <div
        onClick={onToggleExpanded}
        className="h-7 px-3 flex items-center justify-between cursor-pointer hover:bg-zinc-800/60 select-none"
      >
        <div className="flex items-center gap-2.5">
          <span
            className={`w-2 h-2 rounded-full ${
              activeCount > 0
                ? "bg-emerald-400 animate-pulse"
                : "bg-zinc-600"
            }`}
          />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-200">
            Transfer Queue
          </span>
          <span className="text-[11px] text-zinc-400">
            ({activeCount} active · {finishedCount} finished)
          </span>
          {activeCount > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-emerald-950/50 border border-emerald-800/70 text-[10px] text-emerald-300">
              {formatThroughputMBps(totalSpeedBps)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {finishedCount > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClearFinished();
              }}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-zinc-700 hover:border-zinc-600 bg-slate-950 text-[10px] text-zinc-300"
            >
              <Trash2 className="w-3 h-3" />
              <span>Clear Finished</span>
            </button>
          )}
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
          ) : (
            <ChevronUp className="w-3.5 h-3.5 text-zinc-400" />
          )}
        </div>
      </div>

      {/* Expanded Transfer Table */}
      {isExpanded && (
        <div className="max-h-40 overflow-y-auto bg-slate-950 border-t border-zinc-800 divide-y divide-zinc-900">
          {transfers.length === 0 ? (
            <div className="py-4 text-center text-[11px] text-zinc-500">
              Queue idle. Drag files between panes or click Upload / Download.
            </div>
          ) : (
            transfers.map((item) => {
              const pct =
                item.bytes_total > 0
                  ? Math.min(
                      100,
                      Math.round((item.bytes_done / item.bytes_total) * 100),
                    )
                  : item.status === "completed"
                    ? 100
                    : 0;

              const isRunning =
                item.status === "in_progress" || item.status === "queued";

              const statusBadge =
                item.status === "completed"
                  ? "text-emerald-400"
                  : item.status === "in_progress"
                    ? "text-amber-300"
                    : item.status === "queued"
                      ? "text-zinc-400"
                      : item.status === "cancelled"
                        ? "text-zinc-500"
                        : "text-rose-400";

              return (
                <div
                  key={item.transfer_id}
                  className="px-3 py-1.5 flex items-center gap-3 text-[11px]"
                >
                  {/* Direction */}
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] shrink-0 ${
                      item.direction === "upload"
                        ? "border-emerald-800/70 bg-emerald-950/40 text-emerald-300"
                        : "border-cyan-800/70 bg-cyan-950/40 text-cyan-300"
                    }`}
                  >
                    {item.direction === "upload" ? (
                      <>
                        <ArrowUpRight className="w-3 h-3" />
                        <span>UP</span>
                      </>
                    ) : (
                      <>
                        <ArrowDownLeft className="w-3 h-3" />
                        <span>DOWN</span>
                      </>
                    )}
                  </span>

                  {/* File Name & Tooltip */}
                  <div
                    title={`${item.source_path} -> ${item.dest_path}${
                      item.error ? ` (${item.error})` : ""
                    }`}
                    className="w-52 truncate text-zinc-200 shrink-0"
                  >
                    {item.file_name}
                  </div>

                  {/* Progress Bar */}
                  <div className="flex-1 min-w-[120px] flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-zinc-900 rounded-full overflow-hidden border border-zinc-800">
                      <div
                        style={{ width: `${pct}%` }}
                        className={`h-full transition-all duration-75 ${
                          item.status === "failed"
                            ? "bg-rose-500"
                            : item.status === "cancelled"
                              ? "bg-zinc-600"
                              : item.direction === "upload"
                                ? "bg-emerald-500"
                                : "bg-cyan-500"
                        }`}
                      />
                    </div>
                    <span className="w-36 text-right text-zinc-400 shrink-0">
                      {formatBytes(item.bytes_done)} /{" "}
                      {formatBytes(item.bytes_total)}
                    </span>
                  </div>

                  {/* Throughput in MB/s */}
                  <div className="w-24 text-right text-zinc-300 shrink-0">
                    {item.status === "in_progress" ||
                    item.status === "completed"
                      ? formatThroughputMBps(item.speed_bps)
                      : "—"}
                  </div>

                  {/* Status / Error */}
                  <div
                    title={item.error ?? undefined}
                    className={`w-20 text-right uppercase text-[10px] shrink-0 truncate ${statusBadge}`}
                  >
                    {item.status.replace("_", " ")}
                  </div>

                  {/* Cancel Action */}
                  <div className="w-6 flex justify-end shrink-0">
                    {isRunning && (
                      <button
                        type="button"
                        onClick={() => onCancelTransfer(item.transfer_id)}
                        title="Cancel Transfer"
                        className="p-0.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-rose-400"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
