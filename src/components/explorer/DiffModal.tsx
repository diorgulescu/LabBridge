import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileDiff,
  RefreshCw,
  X,
} from "lucide-react";
import {
  compareFileHashes,
  diffReadContents,
  formatError,
} from "../../lib/ipc";
import { formatBytes } from "./formatters";
import type {
  DiffContentsResponse,
  FileHashComparison,
} from "../../types/labbridge";

interface DiffModalProps {
  isOpen: boolean;
  profileId: string;
  localPath: string;
  remotePath: string;
  onClose: () => void;
  onUploadLocalToRemote: (localPath: string, remotePath: string) => void;
  onDownloadRemoteToLocal: (remotePath: string, localPath: string) => void;
}

interface AlignedDiffRow {
  kind: "equal" | "del" | "add" | "mod";
  leftLineNo: number | null;
  leftText: string | null;
  rightLineNo: number | null;
  rightText: string | null;
}

function computeAlignedDiff(leftRaw: string, rightRaw: string): AlignedDiffRow[] {
  const a = leftRaw.length === 0 ? [] : leftRaw.split("\n");
  const b = rightRaw.length === 0 ? [] : rightRaw.split("\n");

  // Fast prefix/suffix trim
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const rows: AlignedDiffRow[] = [];
  for (let i = 0; i < start; i++) {
    rows.push({
      kind: "equal",
      leftLineNo: i + 1,
      leftText: a[i],
      rightLineNo: i + 1,
      rightText: b[i],
    });
  }

  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);

  if (midA.length > 0 || midB.length > 0) {
    // Bounded DP LCS for crisp line alignment; fallback to paired window for huge middle diffs
    if (midA.length * midB.length <= 900_000) {
      const m = midA.length;
      const n = midB.length;
      const dp = new Uint16Array((m + 1) * (n + 1));
      const stride = n + 1;

      for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
          if (midA[i] === midB[j]) {
            dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1;
          } else {
            const down = dp[(i + 1) * stride + j];
            const right = dp[i * stride + (j + 1)];
            dp[i * stride + j] = down >= right ? down : right;
          }
        }
      }

      let i = 0;
      let j = 0;
      while (i < m && j < n) {
        if (midA[i] === midB[j]) {
          rows.push({
            kind: "equal",
            leftLineNo: start + i + 1,
            leftText: midA[i],
            rightLineNo: start + j + 1,
            rightText: midB[j],
          });
          i++;
          j++;
        } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
          rows.push({
            kind: "del",
            leftLineNo: start + i + 1,
            leftText: midA[i],
            rightLineNo: null,
            rightText: null,
          });
          i++;
        } else {
          rows.push({
            kind: "add",
            leftLineNo: null,
            leftText: null,
            rightLineNo: start + j + 1,
            rightText: midB[j],
          });
          j++;
        }
      }
      while (i < m) {
        rows.push({
          kind: "del",
          leftLineNo: start + i + 1,
          leftText: midA[i],
          rightLineNo: null,
          rightText: null,
        });
        i++;
      }
      while (j < n) {
        rows.push({
          kind: "add",
          leftLineNo: null,
          leftText: null,
          rightLineNo: start + j + 1,
          rightText: midB[j],
        });
        j++;
      }
    } else {
      const maxLen = Math.max(midA.length, midB.length);
      for (let k = 0; k < maxLen; k++) {
        const hasL = k < midA.length;
        const hasR = k < midB.length;
        if (hasL && hasR && midA[k] === midB[k]) {
          rows.push({
            kind: "equal",
            leftLineNo: start + k + 1,
            leftText: midA[k],
            rightLineNo: start + k + 1,
            rightText: midB[k],
          });
        } else {
          rows.push({
            kind: hasL && hasR ? "mod" : hasL ? "del" : "add",
            leftLineNo: hasL ? start + k + 1 : null,
            leftText: hasL ? midA[k] : null,
            rightLineNo: hasR ? start + k + 1 : null,
            rightText: hasR ? midB[k] : null,
          });
        }
      }
    }
  }

  const suffixCount = a.length - 1 - endA;
  for (let k = 1; k <= suffixCount; k++) {
    rows.push({
      kind: "equal",
      leftLineNo: endA + k + 1,
      leftText: a[endA + k],
      rightLineNo: endB + k + 1,
      rightText: b[endB + k],
    });
  }

  return rows;
}

export const DiffModal: React.FC<DiffModalProps> = ({
  isOpen,
  profileId,
  localPath,
  remotePath,
  onClose,
  onUploadLocalToRemote,
  onDownloadRemoteToLocal,
}) => {
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hashInfo, setHashInfo] = useState<FileHashComparison | null>(null);
  const [diffData, setDiffData] = useState<DiffContentsResponse | null>(null);
  const [changesOnly, setChangesOnly] = useState(false);

  const runComparison = async () => {
    if (!profileId || !localPath || !remotePath) return;
    setLoading(true);
    setError(null);
    setHashInfo(null);
    setDiffData(null);

    try {
      const hashes = await compareFileHashes(profileId, localPath, remotePath);
      setHashInfo(hashes);

      setLoadingText(true);
      const contents = await diffReadContents(profileId, localPath, remotePath);
      setDiffData(contents);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
      setLoadingText(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    void runComparison();

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, profileId, localPath, remotePath]);

  const rows = useMemo(() => {
    if (!diffData || diffData.is_binary) return [];
    const all = computeAlignedDiff(diffData.local_text, diffData.remote_text);
    return changesOnly ? all.filter((r) => r.kind !== "equal") : all;
  }, [diffData, changesOnly]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-6xl h-[86vh] bg-zinc-900 border border-zinc-800 rounded shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Top Header */}
        <div className="h-11 px-4 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between gap-3 shrink-0 font-mono text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <FileDiff className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="font-semibold uppercase tracking-wider text-zinc-100">
              Quick File Diff &amp; SHA-256 Verification
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer mr-2">
              <input
                type="checkbox"
                checked={changesOnly}
                onChange={(e) => setChangesOnly(e.target.checked)}
              />
              <span>Changes only</span>
            </label>

            <button
              type="button"
              onClick={() => {
                onUploadLocalToRemote(localPath, remotePath);
                onClose();
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-emerald-700/80 bg-emerald-950/50 hover:bg-emerald-900/60 text-emerald-200 text-[11px]"
            >
              <span>Upload</span>
              <ArrowRight className="w-3 h-3" />
            </button>

            <button
              type="button"
              onClick={() => {
                onDownloadRemoteToLocal(remotePath, localPath);
                onClose();
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-cyan-700/80 bg-cyan-950/50 hover:bg-cyan-900/60 text-cyan-200 text-[11px]"
            >
              <ArrowLeft className="w-3 h-3" />
              <span>Download</span>
            </button>

            <button
              type="button"
              onClick={() => void runComparison()}
              title="Recompute SHA-256 & Diff"
              className="p-1.5 rounded border border-zinc-800 hover:bg-zinc-800 text-zinc-300"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
              />
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* SHA-256 Telemetry Strip */}
        <div className="px-4 py-2.5 bg-slate-950 border-b border-zinc-800 font-mono text-[11px] space-y-1.5 shrink-0">
          {hashInfo && (
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex items-center gap-2">
                {hashInfo.matches ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-700/70 text-emerald-300 font-semibold">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    SHA-256 MATCH (IDENTICAL)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-950/60 border border-amber-700/70 text-amber-300 font-semibold">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    SHA-256 MISMATCH (DIVERGED)
                  </span>
                )}
              </div>
              {diffData?.truncated && (
                <span className="text-amber-400 text-[10px]">
                  Preview truncated at 1 MiB
                </span>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-zinc-900/80 border border-zinc-800 rounded px-2.5 py-1.5 min-w-0">
              <div className="flex items-center justify-between text-[10px] text-zinc-500">
                <span>LOCAL WORKSTATION</span>
                {hashInfo && <span>{formatBytes(hashInfo.local_size)}</span>}
              </div>
              <div className="text-zinc-200 truncate" title={localPath}>
                {localPath}
              </div>
              {hashInfo && (
                <div className="text-[10px] text-zinc-400 truncate select-all mt-0.5">
                  sha256: {hashInfo.local_sha256}
                </div>
              )}
            </div>

            <div className="bg-zinc-900/80 border border-zinc-800 rounded px-2.5 py-1.5 min-w-0">
              <div className="flex items-center justify-between text-[10px] text-zinc-500">
                <span>REMOTE LINUX (SSH EXEC sha256sum)</span>
                {hashInfo?.remote_size !== null &&
                  hashInfo?.remote_size !== undefined && (
                    <span>{formatBytes(hashInfo.remote_size)}</span>
                  )}
              </div>
              <div className="text-zinc-200 truncate" title={remotePath}>
                {remotePath}
              </div>
              {hashInfo && (
                <div className="text-[10px] text-zinc-400 truncate select-all mt-0.5">
                  sha256: {hashInfo.remote_sha256}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Diff Viewport */}
        <div className="flex-1 min-h-0 overflow-auto bg-slate-950 font-mono text-xs">
          {loading || loadingText ? (
            <div className="h-full flex items-center justify-center text-zinc-400">
              Computing SHA-256 digests and fetching remote SFTP buffer...
            </div>
          ) : error ? (
            <div className="p-6 text-rose-300 space-y-2">
              <div className="font-semibold">Comparison failed</div>
              <div className="text-rose-400/90 text-[11px]">{error}</div>
            </div>
          ) : diffData?.is_binary ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-400 gap-1">
              <span>Binary file detected — text diff suppressed.</span>
              <span className="text-[11px] text-zinc-500">
                Refer to the SHA-256 digest and byte size verification above.
              </span>
            </div>
          ) : rows.length === 0 ? (
            <div className="h-full flex items-center justify-center text-zinc-500">
              {changesOnly
                ? "No line differences found between Local and Remote files."
                : "Both files are empty."}
            </div>
          ) : (
            <table className="w-full border-collapse table-fixed text-[11px] leading-5">
              <colgroup>
                <col className="w-12" />
                <col />
                <col className="w-12" />
                <col />
              </colgroup>
              <tbody>
                {rows.map((row, idx) => {
                  const leftBg =
                    row.kind === "del" || row.kind === "mod"
                      ? "bg-rose-950/45 text-rose-200"
                      : row.leftLineNo === null
                        ? "bg-zinc-950/70"
                        : "text-zinc-300";

                  const rightBg =
                    row.kind === "add" || row.kind === "mod"
                      ? "bg-emerald-950/45 text-emerald-200"
                      : row.rightLineNo === null
                        ? "bg-zinc-950/70"
                        : "text-zinc-300";

                  return (
                    <tr
                      key={idx}
                      className="border-b border-zinc-900/80 hover:bg-zinc-900/30"
                    >
                      <td className="px-2 text-right text-zinc-600 select-none bg-zinc-950 border-r border-zinc-800/80">
                        {row.leftLineNo ?? ""}
                      </td>
                      <td
                        className={`px-2.5 whitespace-pre overflow-x-hidden text-ellipsis border-r border-zinc-800 ${leftBg}`}
                      >
                        {row.leftText ?? ""}
                      </td>
                      <td className="px-2 text-right text-zinc-600 select-none bg-zinc-950 border-r border-zinc-800/80">
                        {row.rightLineNo ?? ""}
                      </td>
                      <td
                        className={`px-2.5 whitespace-pre overflow-x-hidden text-ellipsis ${rightBg}`}
                      >
                        {row.rightText ?? ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
