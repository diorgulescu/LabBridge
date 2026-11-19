import React from "react";
import {
  ArrowDown,
  ArrowUp,
  Code2,
  CornerLeftUp,
  File,
  FileCode2,
  Folder,
  FolderPlus,
  FolderSymlink,
  HardDrive,
  Navigation,
  RefreshCw,
  Search,
  Server,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";
import {
  formatBytes,
  formatMtime,
  splitBreadcrumbs,
  type SortField,
} from "./formatters";
import type { FsEntry } from "../../types/labbridge";
import type { FilePaneState } from "./useFilePaneState";

export type PaneSide = "local" | "remote";

interface FilePaneProps {
  side: PaneSide;
  pane: FilePaneState;
  profileLabel?: string;
  remoteConnected: boolean;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onSubmitNewFolder: (e: React.FormEvent) => void;
  onRowDoubleClick: (entry: FsEntry) => void;
  onRowContextMenu: (e: React.MouseEvent, entry: FsEntry) => void;
  onRowDragStart: (e: React.DragEvent, entry: FsEntry) => void;
  onRowDragOver: (e: React.DragEvent, entry: FsEntry) => void;
  onRowDrop: (e: React.DragEvent, entry: FsEntry) => void;
  onPaneDragOver: (e: React.DragEvent) => void;
  onPaneDragLeave: (e: React.DragEvent) => void;
  onPaneDrop: (e: React.DragEvent) => void;
  dragOver: boolean;
  renamingTarget: { side: PaneSide; entry: FsEntry; value: string } | null;
  onRenameChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onOpenVscode?: () => void;
  onQueueUpload?: () => void;
  uploadDisabled?: boolean;
  onQueueDownload?: () => void;
  downloadDisabled?: boolean;
  showPermissions?: boolean;
  widthPercent: number;
  emptyMessage: string;
  connectPrompt?: React.ReactNode;
}

export const FilePane: React.FC<FilePaneProps> = ({
  side,
  pane,
  profileLabel,
  remoteConnected,
  onNavigate,
  onRefresh,
  onSubmitNewFolder,
  onRowDoubleClick,
  onRowContextMenu,
  onRowDragStart,
  onRowDragOver,
  onRowDrop,
  onPaneDragOver,
  onPaneDragLeave,
  onPaneDrop,
  dragOver,
  renamingTarget,
  onRenameChange,
  onCommitRename,
  onCancelRename,
  onOpenVscode,
  onQueueUpload,
  uploadDisabled,
  onQueueDownload,
  downloadDisabled,
  showPermissions = false,
  widthPercent,
  emptyMessage,
  connectPrompt,
}) => {
  const isLocal = side === "local";
  const icon = isLocal ? (
    <HardDrive className="w-3.5 h-3.5 text-sky-400 shrink-0" />
  ) : (
    <Server className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
  );
  const title = isLocal ? "Local Workstation" : `Remote Linux SFTP${profileLabel ? ` (${profileLabel})` : ""}`;

  const renderEntryIcon = (entry: FsEntry) => {
    if (entry.kind === "symlink" && entry.is_dir_like) {
      return <FolderSymlink className="w-3.5 h-3.5 text-cyan-400 shrink-0" />;
    }
    if (entry.is_dir_like) {
      return <Folder className="w-3.5 h-3.5 text-amber-400/90 shrink-0" />;
    }
    if (entry.is_executable) {
      return <FileCode2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    }
    return <File className="w-3.5 h-3.5 text-zinc-500 shrink-0" />;
  };

  const renderSortArrow = (col: SortField) => {
    if (pane.sortField !== col) return null;
    return pane.sortDir === "asc" ? (
      <ArrowUp className="w-3 h-3 text-emerald-400 inline ml-0.5" />
    ) : (
      <ArrowDown className="w-3 h-3 text-emerald-400 inline ml-0.5" />
    );
  };

  return (
    <section
      style={{ width: `${widthPercent}%` }}
      onDragOver={onPaneDragOver}
      onDragLeave={onPaneDragLeave}
      onDrop={onPaneDrop}
      className={`h-full min-w-[240px] flex flex-col bg-slate-950 transition-colors ${
        dragOver
          ? isLocal
            ? "ring-1 ring-inset ring-cyan-500/80 bg-cyan-950/10"
            : "ring-1 ring-inset ring-emerald-500/80 bg-emerald-950/10"
          : ""
      } ${!isLocal ? "flex-1 min-w-[260px]" : ""}`}
    >
      {/* Pane Header */}
      <div className="h-8 px-2.5 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between gap-2 shrink-0 font-mono text-xs">
        <div className="flex items-center gap-1.5 text-zinc-200 min-w-0">
          {icon}
          <span className="font-semibold text-[11px] uppercase tracking-wider truncate">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isLocal && onOpenVscode && (
            <button
              type="button"
              onClick={onOpenVscode}
              title="Launch `code` detached on Workspace Root"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-sky-800/80 bg-sky-950/40 hover:bg-sky-900/50 text-sky-200 text-[10px]"
            >
              <Code2 className="w-3 h-3" />
              <span>Open Workspace in VS Code</span>
            </button>
          )}
          {isLocal && onQueueUpload && (
            <button
              type="button"
              disabled={uploadDisabled}
              onClick={onQueueUpload}
              title="Queue Upload to Current Remote Directory"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-700/80 bg-emerald-950/50 hover:bg-emerald-900/60 disabled:opacity-35 disabled:pointer-events-none text-emerald-200 text-[10px]"
            >
              <span>Upload</span>
              <ArrowRight className="w-3 h-3" />
            </button>
          )}
          {!isLocal && onQueueDownload && (
            <button
              type="button"
              disabled={downloadDisabled}
              onClick={onQueueDownload}
              title="Queue Download (Recursive for Directories) to Current Local Folder"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-cyan-700/80 bg-cyan-950/50 hover:bg-cyan-900/60 disabled:opacity-35 disabled:pointer-events-none text-cyan-200 text-[10px]"
            >
              <ArrowLeft className="w-3 h-3" />
              <span>Download</span>
            </button>
          )}
        </div>
      </div>

      {/* Breadcrumbs / Quick Jump / Filter Bar */}
      <div className="px-2 py-1 bg-zinc-900/50 border-b border-zinc-800/90 flex items-center gap-1.5 shrink-0 font-mono text-[11px]">
        <button
          type="button"
          disabled={!pane.listing?.parent_path}
          onClick={() => {
            if (pane.listing?.parent_path) onNavigate(pane.listing.parent_path);
          }}
          title={isLocal ? "Parent Directory" : "Parent POSIX Directory"}
          className="p-1 rounded hover:bg-zinc-800 disabled:opacity-30 text-zinc-300"
        >
          <CornerLeftUp className="w-3.5 h-3.5" />
        </button>

        {pane.jumpOpen ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              pane.setJumpOpen(false);
              onNavigate(pane.jumpInput);
            }}
            className="flex-1 min-w-0"
          >
            <input
              autoFocus
              type="text"
              value={pane.jumpInput}
              placeholder={isLocal ? undefined : "/var/log or ~/workspace"}
              onChange={(e) => pane.setJumpInput(e.target.value)}
              onBlur={() => pane.setJumpOpen(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") pane.setJumpOpen(false);
              }}
              className="w-full bg-slate-950 border border-emerald-600/80 rounded px-2 py-0.5 text-[11px] text-zinc-100 focus:outline-none"
            />
          </form>
        ) : (
          <div
            onDoubleClick={() => pane.setJumpOpen(true)}
            className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto bg-slate-950 border border-zinc-800 rounded px-1.5 py-0.5"
          >
            {splitBreadcrumbs(pane.listing?.path ?? (isLocal ? "" : "/"), !isLocal).map(
              (crumb, i, arr) => (
                <React.Fragment key={crumb.path}>
                  <button
                    type="button"
                    onClick={() => onNavigate(crumb.path)}
                    className={`px-1 rounded hover:bg-zinc-800 truncate max-w-[130px] ${
                      i === arr.length - 1
                        ? isLocal
                          ? "text-zinc-100 font-medium"
                          : "text-emerald-300 font-medium"
                        : "text-zinc-400"
                    }`}
                  >
                    {crumb.label}
                  </button>
                  {i < arr.length - 1 && (!isLocal || crumb.label !== "/") && (
                    <span className="text-zinc-600">/</span>
                  )}
                </React.Fragment>
              ),
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => pane.setJumpOpen((v) => !v)}
          title={isLocal ? "Jump to Local Path" : "Quick Path Jump"}
          className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
        >
          <Navigation className="w-3 h-3" />
        </button>

        <div className="relative w-32 shrink-0">
          <Search className="w-3 h-3 text-zinc-500 absolute left-1.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={pane.filter}
            placeholder="Filter..."
            onChange={(e) => pane.setFilter(e.target.value)}
            className="w-full bg-slate-950 border border-zinc-800 focus:border-zinc-600 focus:outline-none rounded pl-5 pr-1.5 py-0.5 text-[11px] text-zinc-200"
          />
        </div>

        <button
          type="button"
          onClick={() => pane.setNewFolderOpen((v) => !v)}
          title={isLocal ? "New Local Folder" : "New Remote POSIX Directory"}
          className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
        >
          <FolderPlus className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={onRefresh}
          title={isLocal ? "Refresh Local Directory" : "Refresh SFTP Directory"}
          className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${pane.loading ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {/* New Folder Form */}
      {pane.newFolderOpen && (
        <form
          onSubmit={onSubmitNewFolder}
          className="px-2.5 py-1.5 bg-zinc-900 border-b border-zinc-800 flex items-center gap-2 font-mono text-xs shrink-0"
        >
          <span className="text-[11px] text-zinc-400">
            {isLocal ? "New Folder:" : "Remote mkdir:"}
          </span>
          <input
            autoFocus
            type="text"
            value={pane.newFolderName}
            onChange={(e) => pane.setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") pane.setNewFolderOpen(false);
            }}
            placeholder={isLocal ? "folder_name" : "new_dir"}
            className="flex-1 bg-slate-950 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-100 focus:outline-none"
          />
          <button
            type="submit"
            className="px-2 py-0.5 rounded bg-emerald-600 text-slate-950 font-semibold text-[11px]"
          >
            Create
          </button>
        </form>
      )}

      {/* File Table or Connect Prompt */}
      {!isLocal && !remoteConnected && connectPrompt ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2.5 p-4 font-mono text-center">
          {connectPrompt}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <table className="w-full border-collapse font-mono text-[11px]">
            <thead className="sticky top-0 z-10 bg-zinc-950 border-b border-zinc-800 text-[10px] uppercase text-zinc-500">
              <tr>
                <th
                  onClick={() => pane.toggleSort("name")}
                  className="px-2.5 py-1.5 text-left cursor-pointer hover:text-zinc-300"
                >
                  Name {renderSortArrow("name")}
                </th>
                {showPermissions && (
                  <th className="w-32 px-2 py-1.5 text-left">Permissions</th>
                )}
                <th
                  onClick={() => pane.toggleSort("size")}
                  className="w-24 px-2 py-1.5 text-right cursor-pointer hover:text-zinc-300"
                >
                  Size {renderSortArrow("size")}
                </th>
                <th
                  onClick={() => pane.toggleSort("mtime")}
                  className="w-36 px-2.5 py-1.5 text-right cursor-pointer hover:text-zinc-300"
                >
                  Modified {renderSortArrow("mtime")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900/70">
              {pane.sortedEntries.map((entry) => {
                const selected = entry.path === pane.selectedPath;
                const isRenaming =
                  renamingTarget?.side === side &&
                  renamingTarget.entry.path === entry.path;

                return (
                  <tr
                    key={entry.path}
                    draggable={!isRenaming}
                    onDragStart={(e) => onRowDragStart(e, entry)}
                    onDragOver={(e) => onRowDragOver(e, entry)}
                    onDrop={(e) => onRowDrop(e, entry)}
                    onClick={() => pane.setSelectedPath(entry.path)}
                    onDoubleClick={() => onRowDoubleClick(entry)}
                    onContextMenu={(e) => onRowContextMenu(e, entry)}
                    className={`cursor-pointer ${
                      selected
                        ? "bg-emerald-950/35 text-zinc-100"
                        : "hover:bg-zinc-900/60 text-zinc-300"
                    }`}
                  >
                    <td className="px-2.5 py-1 max-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {renderEntryIcon(entry)}
                        {isRenaming ? (
                          <input
                            autoFocus
                            type="text"
                            value={renamingTarget.value}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => onRenameChange(e.target.value)}
                            onBlur={onCommitRename}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") onCommitRename();
                              if (e.key === "Escape") onCancelRename();
                            }}
                            className="flex-1 bg-zinc-900 border border-emerald-500 rounded px-1 py-0 text-[11px] text-zinc-100 focus:outline-none"
                          />
                        ) : (
                          <span
                            className={`truncate ${
                              entry.is_executable ? "text-emerald-300" : ""
                            }`}
                          >
                            {entry.name}
                          </span>
                        )}
                      </div>
                    </td>
                    {showPermissions && (
                      <td className="px-2 py-1 whitespace-nowrap">
                        {entry.permissions_rwx ? (
                          <span className="inline-flex items-center gap-1 text-[10px]">
                            <span
                              className={
                                entry.is_executable
                                  ? "text-emerald-400"
                                  : "text-zinc-400"
                              }
                            >
                              {entry.permissions_rwx}
                            </span>
                            <span className="text-zinc-600">
                              {entry.permissions_octal}
                            </span>
                          </span>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                    )}
                    <td className="px-2 py-1 text-right text-zinc-500 whitespace-nowrap">
                      {entry.is_dir_like ? "—" : formatBytes(entry.size)}
                    </td>
                    <td className="px-2.5 py-1 text-right text-zinc-500 whitespace-nowrap">
                      {formatMtime(entry.mtime)}
                    </td>
                  </tr>
                );
              })}
              {pane.sortedEntries.length === 0 && !pane.loading && (
                <tr>
                  <td
                    colSpan={showPermissions ? 4 : 3}
                    className="py-8 text-center text-zinc-600 text-xs"
                  >
                    {emptyMessage}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
