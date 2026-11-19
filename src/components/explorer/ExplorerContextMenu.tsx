import React, { useEffect, useRef } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  Copy,
  FileDiff,
  Pencil,
  Shield,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import type { FsEntry } from "../../types/labbridge";

export interface ContextMenuState {
  x: number;
  y: number;
  side: "local" | "remote";
  entry: FsEntry;
}

interface ExplorerContextMenuProps {
  menu: ContextMenuState | null;
  canTransfer: boolean;
  hasActiveTerminal: boolean;
  onClose: () => void;
  onTransfer: (side: "local" | "remote", entry: FsEntry) => void;
  onCompareDiff: (side: "local" | "remote", entry: FsEntry) => void;
  onToggleExecutable: (entry: FsEntry) => void;
  onCopyPath: (path: string) => void;
  onSendCdToTerminal: (side: "local" | "remote", entry: FsEntry) => void;
  onOpenInVscode: (path: string) => void;
  onStartRename: (side: "local" | "remote", entry: FsEntry) => void;
  onRequestDelete: (side: "local" | "remote", entry: FsEntry) => void;
}

export const ExplorerContextMenu: React.FC<ExplorerContextMenuProps> = ({
  menu,
  canTransfer,
  hasActiveTerminal,
  onClose,
  onTransfer,
  onCompareDiff,
  onToggleExecutable,
  onCopyPath,
  onSendCdToTerminal,
  onOpenInVscode,
  onStartRename,
  onRequestDelete,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;

    const handlePointerDown = (ev: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const { side, entry } = menu;
  const clampedLeft = Math.min(menu.x, window.innerWidth - 260);
  const clampedTop = Math.min(menu.y, window.innerHeight - 310);

  const isFile = !entry.is_dir_like;

  return (
    <div
      ref={menuRef}
      style={{ left: `${clampedLeft}px`, top: `${clampedTop}px` }}
      className="fixed z-50 w-60 bg-zinc-900 border border-zinc-700 rounded shadow-2xl py-1 font-mono text-xs text-zinc-200"
    >
      <div className="px-2.5 py-1 border-b border-zinc-800 text-[10px] text-zinc-500 truncate">
        {entry.name}
      </div>

      {/* Transfer Action */}
      <button
        type="button"
        disabled={!canTransfer}
        onClick={() => {
          onTransfer(side, entry);
          onClose();
        }}
        className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none text-left"
      >
        {side === "local" ? (
          <>
            <ArrowRight className="w-3.5 h-3.5 text-emerald-400" />
            <span>Upload -&gt; Remote</span>
          </>
        ) : (
          <>
            <ArrowLeft className="w-3.5 h-3.5 text-cyan-400" />
            <span>&lt;- Download to Local</span>
          </>
        )}
      </button>

      {/* Compare Local vs Remote (Diff Modal) */}
      {isFile && (
        <button
          type="button"
          disabled={!canTransfer}
          onClick={() => {
            onCompareDiff(side, entry);
            onClose();
          }}
          className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none text-left"
        >
          <FileDiff className="w-3.5 h-3.5 text-amber-400" />
          <span>Compare Local vs Remote</span>
        </button>
      )}

      {/* Remote Only: Toggle Executable (+x) */}
      {side === "remote" && isFile && (
        <button
          type="button"
          onClick={() => {
            onToggleExecutable(entry);
            onClose();
          }}
          className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-zinc-800 text-left"
        >
          <Shield className="w-3.5 h-3.5 text-emerald-400" />
          <span>
            {entry.is_executable
              ? "Clear Executable (-x)"
              : "Toggle Executable (+x)"}
          </span>
        </button>
      )}

      {/* Local Only: Open in VS Code */}
      {side === "local" && (
        <button
          type="button"
          onClick={() => {
            onOpenInVscode(entry.path);
            onClose();
          }}
          className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-zinc-800 text-left"
        >
          <Code2 className="w-3.5 h-3.5 text-sky-400" />
          <span>Open in VS Code</span>
        </button>
      )}

      <div className="my-1 border-t border-zinc-800" />

      {/* Copy Path */}
      <button
        type="button"
        onClick={() => {
          onCopyPath(entry.path);
          onClose();
        }}
        className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-zinc-800 text-left"
      >
        <Copy className="w-3.5 h-3.5 text-zinc-400" />
        <span>{side === "remote" ? "Copy Remote Path" : "Copy Local Path"}</span>
      </button>

      {/* Send cd <dir> to Active Terminal */}
      {side === "remote" && (
        <button
          type="button"
          disabled={!hasActiveTerminal}
          onClick={() => {
            onSendCdToTerminal(side, entry);
            onClose();
          }}
          className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none text-left"
        >
          <TerminalSquare className="w-3.5 h-3.5 text-emerald-400" />
          <span>Send `cd &lt;dir&gt;` to Terminal</span>
        </button>
      )}

      <div className="my-1 border-t border-zinc-800" />

      {/* Rename & Delete */}
      <button
        type="button"
        onClick={() => {
          onStartRename(side, entry);
          onClose();
        }}
        className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-zinc-800 text-left"
      >
        <Pencil className="w-3.5 h-3.5 text-zinc-400" />
        <span>Rename</span>
      </button>

      <button
        type="button"
        onClick={() => {
          onRequestDelete(side, entry);
          onClose();
        }}
        className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-rose-950/60 text-rose-300 text-left"
      >
        <Trash2 className="w-3.5 h-3.5 text-rose-400" />
        <span>Delete</span>
      </button>
    </div>
  );
};
