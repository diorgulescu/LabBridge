import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
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
  Plug,
  RefreshCw,
  Search,
  Server,
} from "lucide-react";
import {
  formatError,
  fsLocalCreateDir,
  fsLocalDelete,
  fsLocalListDir,
  fsLocalRename,
  joinLocalPath,
  joinPosixPath,
  normalizePosixPath,
  openInVscode,
  sftpChmod,
  sftpCreateDir,
  sftpDelete,
  sftpListDir,
  sftpRename,
  transferCancel,
  transferClearFinished,
  transferEnqueue,
  transferList,
  transferSubscribe,
} from "../../lib/ipc";
import {
  filterAndSortEntries,
  formatBytes,
  formatMtime,
  splitBreadcrumbs,
  type SortDirection,
  type SortField,
} from "./formatters";
import {
  ExplorerContextMenu,
  type ContextMenuState,
} from "./ExplorerContextMenu";
import { TransferDrawer } from "./TransferDrawer";
import { DiffModal } from "./DiffModal";
import type {
  ConnectionStatusPayload,
  DirListing,
  FsEntry,
  TransferProgressEvent,
  WorkspaceProfile,
} from "../../types/labbridge";

const DND_MIME = "application/x-labbridge-fs-entry";

interface DraggedPayload {
  side: "local" | "remote";
  entry: FsEntry;
}

interface DualPaneExplorerProps {
  profile: WorkspaceProfile | null;
  status: ConnectionStatusPayload | null;
  hasActiveTerminal: boolean;
  syncRefreshTick?: number;
  leftRatio: number;
  onLeftRatioChange: (nextRatio: number) => void;
  followedRemoteDir?: string | null;
  onConnect: () => void;
  onCreateProfile: () => void;
  onSendCommandToTerminal: (command: string) => void;
  onNotifyError: (msg: string) => void;
}

export const DualPaneExplorer: React.FC<DualPaneExplorerProps> = ({
  profile,
  status,
  hasActiveTerminal,
  syncRefreshTick = 0,
  leftRatio,
  onLeftRatioChange,
  followedRemoteDir = null,
  onConnect,
  onCreateProfile,
  onSendCommandToTerminal,
  onNotifyError,
}) => {
  const isConnected = status?.connection_state.state === "Connected";
  const profileId = profile?.id ?? null;

  const splitContainerRef = useRef<HTMLDivElement | null>(null);

  // Local Pane State
  const [localListing, setLocalListing] = useState<DirListing | null>(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [localFilter, setLocalFilter] = useState("");
  const [localSortField, setLocalSortField] = useState<SortField>("name");
  const [localSortDir, setLocalSortDir] = useState<SortDirection>("asc");
  const [selectedLocalPath, setSelectedLocalPath] = useState<string | null>(
    null,
  );
  const [localJumpOpen, setLocalJumpOpen] = useState(false);
  const [localJumpInput, setLocalJumpInput] = useState("");
  const [localNewFolderOpen, setLocalNewFolderOpen] = useState(false);
  const [localNewFolderName, setLocalNewFolderName] = useState("");

  // Remote Pane State
  const [remoteListing, setRemoteListing] = useState<DirListing | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteFilter, setRemoteFilter] = useState("");
  const [remoteSortField, setRemoteSortField] = useState<SortField>("name");
  const [remoteSortDir, setRemoteSortDir] = useState<SortDirection>("asc");
  const [selectedRemotePath, setSelectedRemotePath] = useState<string | null>(
    null,
  );
  const [remoteJumpOpen, setRemoteJumpOpen] = useState(false);
  const [remoteJumpInput, setRemoteJumpInput] = useState("");
  const [remoteNewFolderOpen, setRemoteNewFolderOpen] = useState(false);
  const [remoteNewFolderName, setRemoteNewFolderName] = useState("");

  // Inline Rename & Delete Confirmation
  const [renamingTarget, setRenamingTarget] = useState<{
    side: "local" | "remote";
    entry: FsEntry;
    value: string;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    side: "local" | "remote";
    entry: FsEntry;
  } | null>(null);

  // Drag & Drop Highlight State
  const [dragOverSide, setDragOverSide] = useState<"local" | "remote" | null>(
    null,
  );

  // Context Menu & Diff Modal State
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [diffTarget, setDiffTarget] = useState<{
    localPath: string;
    remotePath: string;
  } | null>(null);

  // Transfer Queue State
  const [transfers, setTransfers] = useState<TransferProgressEvent[]>([]);
  const [drawerExpanded, setDrawerExpanded] = useState(false);

  const localPathRef = useRef<string | undefined>(undefined);
  localPathRef.current = localListing?.path;
  const remotePathRef = useRef<string | undefined>(undefined);
  remotePathRef.current = remoteListing?.path;

  const loadLocalDir = useCallback(
    async (targetPath?: string) => {
      setLocalLoading(true);
      try {
        const res = await fsLocalListDir(targetPath);
        setLocalListing(res);
        setLocalJumpInput(res.path);
      } catch (err) {
        onNotifyError(formatError(err));
      } finally {
        setLocalLoading(false);
      }
    },
    [onNotifyError],
  );

  const loadRemoteDir = useCallback(
    async (pid: string, targetPath?: string) => {
      setRemoteLoading(true);
      try {
        const res = await sftpListDir(pid, targetPath);
        setRemoteListing(res);
        setRemoteJumpInput(res.path);
      } catch (err) {
        onNotifyError(formatError(err));
      } finally {
        setRemoteLoading(false);
      }
    },
    [onNotifyError],
  );

  // Navigate Local pane to profile's local_root_path when profile changes
  useEffect(() => {
    const preferred = profile?.local_root_path?.trim() || undefined;
    void loadLocalDir(preferred);
    setSelectedLocalPath(null);
  }, [profile?.id, profile?.local_root_path, loadLocalDir]);

  // Navigate Remote SFTP pane to profile's remote_root_path when connected
  useEffect(() => {
    if (!profileId || !isConnected) {
      setRemoteListing(null);
      setSelectedRemotePath(null);
      return;
    }
    const preferred = profile?.remote_root_path?.trim() || undefined;
    void loadRemoteDir(profileId, preferred);
  }, [profileId, isConnected, profile?.remote_root_path, loadRemoteDir]);

  // Refresh remote directory view when real-time Local -> Remote sync completes a batch
  useEffect(() => {
    if (!syncRefreshTick || !profileId || !isConnected || !remotePathRef.current) {
      return;
    }
    void loadRemoteDir(profileId, remotePathRef.current);
  }, [syncRefreshTick, profileId, isConnected, loadRemoteDir]);

  // Follow Terminal CWD (OSC 7) when active
  useEffect(() => {
    if (!followedRemoteDir || !profileId || !isConnected) return;
    const normalized = normalizePosixPath(followedRemoteDir);
    if (normalized && normalized !== remotePathRef.current) {
      void loadRemoteDir(profileId, normalized);
    }
  }, [followedRemoteDir, profileId, isConnected, loadRemoteDir]);

  // Subscribe to Transfer Queue progress channel
  useEffect(() => {
    let mounted = true;

    void transferList()
      .then((initial) => {
        if (mounted) setTransfers(initial);
      })
      .catch(() => {});

    void transferSubscribe((ev) => {
      if (!mounted) return;
      setTransfers((prev) => {
        const idx = prev.findIndex((x) => x.transfer_id === ev.transfer_id);
        if (idx === -1) {
          return [ev, ...prev];
        }
        const copy = [...prev];
        copy[idx] = ev;
        return copy;
      });

      if (ev.status === "completed") {
        if (ev.direction === "download") {
          void loadLocalDir(localPathRef.current);
        } else if (ev.direction === "upload" && ev.profile_id === profileId) {
          void loadRemoteDir(ev.profile_id, remotePathRef.current);
        }
      }
    }).catch((err) => {
      if (mounted) onNotifyError(formatError(err));
    });

    return () => {
      mounted = false;
    };
  }, [loadLocalDir, loadRemoteDir, onNotifyError, profileId]);

  const sortedLocalEntries = useMemo(
    () =>
      filterAndSortEntries(
        localListing?.entries ?? [],
        localFilter,
        localSortField,
        localSortDir,
      ),
    [localListing, localFilter, localSortField, localSortDir],
  );

  const sortedRemoteEntries = useMemo(
    () =>
      filterAndSortEntries(
        remoteListing?.entries ?? [],
        remoteFilter,
        remoteSortField,
        remoteSortDir,
      ),
    [remoteListing, remoteFilter, remoteSortField, remoteSortDir],
  );

  const selectedLocalEntry = useMemo(
    () =>
      localListing?.entries.find((e) => e.path === selectedLocalPath) ?? null,
    [localListing, selectedLocalPath],
  );

  const selectedRemoteEntry = useMemo(
    () =>
      remoteListing?.entries.find((e) => e.path === selectedRemotePath) ?? null,
    [remoteListing, selectedRemotePath],
  );

  const toggleSort = (side: "local" | "remote", field: SortField) => {
    if (side === "local") {
      if (localSortField === field) {
        setLocalSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setLocalSortField(field);
        setLocalSortDir("asc");
      }
    } else {
      if (remoteSortField === field) {
        setRemoteSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setRemoteSortField(field);
        setRemoteSortDir("asc");
      }
    }
  };

  // Horizontal Splitter Drag
  const startPaneSplitDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    document.body.style.cursor = "col-resize";

    const onMove = (ev: PointerEvent) => {
      const container = splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (ev.clientX - rect.left) / rect.width;
      onLeftRatioChange(Math.min(0.78, Math.max(0.22, ratio)));
    };

    const onUp = () => {
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Enqueue Upload / Download
  const handleQueueUpload = useCallback(
    async (localSourcePath: string, remoteDestPath: string) => {
      if (!profileId || !isConnected) return;
      try {
        setDrawerExpanded(true);
        await transferEnqueue(
          profileId,
          "upload",
          localSourcePath,
          normalizePosixPath(remoteDestPath),
        );
      } catch (err) {
        onNotifyError(formatError(err));
      }
    },
    [isConnected, onNotifyError, profileId],
  );

  const handleQueueDownload = useCallback(
    async (remoteSourcePath: string, localDestPath: string) => {
      if (!profileId || !isConnected) return;
      try {
        setDrawerExpanded(true);
        await transferEnqueue(
          profileId,
          "download",
          normalizePosixPath(remoteSourcePath),
          localDestPath,
        );
      } catch (err) {
        onNotifyError(formatError(err));
      }
    },
    [isConnected, onNotifyError, profileId],
  );

  const handleTransferEntry = (side: "local" | "remote", entry: FsEntry) => {
    if (side === "local") {
      if (!remoteListing) return;
      const destRemote = joinPosixPath(remoteListing.path, entry.name);
      void handleQueueUpload(entry.path, destRemote);
    } else {
      if (!localListing) return;
      const destLocal = joinLocalPath(localListing.path, entry.name);
      void handleQueueDownload(entry.path, destLocal);
    }
  };

  // Drag & Drop Handlers
  const handleRowDragStart = (
    e: React.DragEvent,
    side: "local" | "remote",
    entry: FsEntry,
  ) => {
    const payload: DraggedPayload = { side, entry };
    e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "copy";
  };

  const handlePaneDrop = (
    e: React.DragEvent,
    targetSide: "local" | "remote",
    targetFolderOverride?: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverSide(null);

    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;

    try {
      const payload = JSON.parse(raw) as DraggedPayload;
      if (payload.side === targetSide) return;

      if (targetSide === "remote" && remoteListing) {
        const destDir = targetFolderOverride ?? remoteListing.path;
        const destPath = joinPosixPath(destDir, payload.entry.name);
        void handleQueueUpload(payload.entry.path, destPath);
      } else if (targetSide === "local" && localListing) {
        const destDir = targetFolderOverride ?? localListing.path;
        const destPath = joinLocalPath(destDir, payload.entry.name);
        void handleQueueDownload(payload.entry.path, destPath);
      }
    } catch {
      // Ignore malformed drag data
    }
  };

  // VS Code Launch
  const handleOpenVscode = async (pathOverride?: string) => {
    const target =
      pathOverride ||
      profile?.local_root_path?.trim() ||
      localListing?.path ||
      "";
    if (!target) return;
    try {
      await openInVscode(target);
    } catch (err) {
      onNotifyError(formatError(err));
    }
  };

  // Create Folder
  const submitLocalNewFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!localListing || !localNewFolderName.trim()) return;
    try {
      const target = joinLocalPath(
        localListing.path,
        localNewFolderName.trim(),
      );
      await fsLocalCreateDir(target);
      setLocalNewFolderName("");
      setLocalNewFolderOpen(false);
      await loadLocalDir(localListing.path);
    } catch (err) {
      onNotifyError(formatError(err));
    }
  };

  const submitRemoteNewFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profileId || !remoteListing || !remoteNewFolderName.trim()) return;
    try {
      const target = joinPosixPath(
        remoteListing.path,
        remoteNewFolderName.trim(),
      );
      await sftpCreateDir(profileId, target);
      setRemoteNewFolderName("");
      setRemoteNewFolderOpen(false);
      await loadRemoteDir(profileId, remoteListing.path);
    } catch (err) {
      onNotifyError(formatError(err));
    }
  };

  // Rename
  const commitRename = async () => {
    if (!renamingTarget) return;
    const { side, entry, value } = renamingTarget;
    const trimmed = value.trim();
    setRenamingTarget(null);
    if (!trimmed || trimmed === entry.name) return;

    try {
      if (side === "local" && localListing) {
        const nextPath = joinLocalPath(localListing.path, trimmed);
        await fsLocalRename(entry.path, nextPath);
        await loadLocalDir(localListing.path);
      } else if (side === "remote" && profileId && remoteListing) {
        const nextPath = joinPosixPath(remoteListing.path, trimmed);
        await sftpRename(profileId, entry.path, nextPath);
        await loadRemoteDir(profileId, remoteListing.path);
      }
    } catch (err) {
      onNotifyError(formatError(err));
    }
  };

  // Delete
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { side, entry } = pendingDelete;
    setPendingDelete(null);

    try {
      if (side === "local" && localListing) {
        await fsLocalDelete(entry.path);
        if (selectedLocalPath === entry.path) setSelectedLocalPath(null);
        await loadLocalDir(localListing.path);
      } else if (side === "remote" && profileId && remoteListing) {
        await sftpDelete(profileId, entry.path, true);
        if (selectedRemotePath === entry.path) setSelectedRemotePath(null);
        await loadRemoteDir(profileId, remoteListing.path);
      }
    } catch (err) {
      onNotifyError(formatError(err));
    }
  };

  // Toggle +x on Remote File
  const handleToggleExecutable = async (entry: FsEntry) => {
    if (!profileId || !remoteListing) return;
    const currentMode = entry.mode ?? 0o644;
    const nextMode = entry.is_executable
      ? currentMode & ~0o111
      : currentMode | 0o111;

    try {
      await sftpChmod(profileId, entry.path, nextMode);
      await loadRemoteDir(profileId, remoteListing.path);
    } catch (err) {
      onNotifyError(formatError(err));
    }
  };

  // Compare Local vs Remote (Diff Modal)
  const handleCompareDiff = (side: "local" | "remote", entry: FsEntry) => {
    if (!localListing || !remoteListing) return;

    if (side === "local") {
      const pairedRemote =
        selectedRemoteEntry && !selectedRemoteEntry.is_dir_like
          ? selectedRemoteEntry.path
          : joinPosixPath(remoteListing.path, entry.name);
      setDiffTarget({ localPath: entry.path, remotePath: pairedRemote });
    } else {
      const pairedLocal =
        selectedLocalEntry && !selectedLocalEntry.is_dir_like
          ? selectedLocalEntry.path
          : joinLocalPath(localListing.path, entry.name);
      setDiffTarget({ localPath: pairedLocal, remotePath: entry.path });
    }
  };

  // Send cd <dir> to Active Terminal
  const handleSendCd = (_side: "local" | "remote", entry: FsEntry) => {
    const dirPosix = entry.is_dir_like
      ? normalizePosixPath(entry.path)
      : normalizePosixPath(remoteListing?.path ?? "/");
    const escaped = `'${dirPosix.replace(/'/g, "'\\''")}'`;
    onSendCommandToTerminal(`cd ${escaped}\n`);
  };

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

  const renderSortArrow = (
    activeField: SortField,
    dir: SortDirection,
    col: SortField,
  ) => {
    if (activeField !== col) return null;
    return dir === "asc" ? (
      <ArrowUp className="w-3 h-3 text-emerald-400 inline ml-0.5" />
    ) : (
      <ArrowDown className="w-3 h-3 text-emerald-400 inline ml-0.5" />
    );
  };

  return (
    <div className="h-full w-full flex flex-col bg-slate-950 overflow-hidden select-none">
      {/* Inline Delete Confirmation Banner */}
      {pendingDelete && (
        <div className="px-3 py-1.5 bg-rose-950/70 border-b border-rose-800 flex items-center justify-between gap-2 font-mono text-xs text-rose-200 shrink-0">
          <span className="truncate">
            Delete {pendingDelete.side.toUpperCase()}{" "}
            {pendingDelete.entry.is_dir_like ? "directory" : "file"} &ldquo;
            {pendingDelete.entry.name}&rdquo;?
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className="px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 text-zinc-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              className="px-2.5 py-0.5 rounded bg-rose-600 hover:bg-rose-500 text-white font-semibold"
            >
              Confirm Delete
            </button>
          </div>
        </div>
      )}

      {/* Dual-Pane Split Workspace */}
      <div
        ref={splitContainerRef}
        className="flex-1 min-h-0 flex overflow-hidden"
      >
        {/* ===================================================================
            LEFT PANE: LOCAL WORKSTATION FILESYSTEM
           =================================================================== */}
        <section
          style={{ width: `${leftRatio * 100}%` }}
          onDragOver={(e) => {
            e.preventDefault();
            if (dragOverSide !== "local") setDragOverSide("local");
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDragOverSide(null);
            }
          }}
          onDrop={(e) => handlePaneDrop(e, "local")}
          className={`h-full min-w-[240px] flex flex-col bg-slate-950 transition-colors ${
            dragOverSide === "local"
              ? "ring-1 ring-inset ring-cyan-500/80 bg-cyan-950/10"
              : ""
          }`}
        >
          {/* Local Pane Header & VS Code Trigger */}
          <div className="h-8 px-2.5 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between gap-2 shrink-0 font-mono text-xs">
            <div className="flex items-center gap-1.5 text-zinc-200 min-w-0">
              <HardDrive className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span className="font-semibold text-[11px] uppercase tracking-wider truncate">
                Local Workstation
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => void handleOpenVscode()}
                title="Launch `code` detached on Workspace Root"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-sky-800/80 bg-sky-950/40 hover:bg-sky-900/50 text-sky-200 text-[10px]"
              >
                <Code2 className="w-3 h-3" />
                <span>Open Workspace in VS Code</span>
              </button>

              <button
                type="button"
                disabled={!isConnected || !selectedLocalEntry || !remoteListing}
                onClick={() => {
                  if (selectedLocalEntry) {
                    handleTransferEntry("local", selectedLocalEntry);
                  }
                }}
                title="Queue Upload to Current Remote Directory"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-700/80 bg-emerald-950/50 hover:bg-emerald-900/60 disabled:opacity-35 disabled:pointer-events-none text-emerald-200 text-[10px]"
              >
                <span>Upload</span>
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Local Breadcrumbs & Filter Bar */}
          <div className="px-2 py-1 bg-zinc-900/50 border-b border-zinc-800/90 flex items-center gap-1.5 shrink-0 font-mono text-[11px]">
            <button
              type="button"
              disabled={!localListing?.parent_path}
              onClick={() => {
                if (localListing?.parent_path) {
                  void loadLocalDir(localListing.parent_path);
                }
              }}
              title="Parent Directory"
              className="p-1 rounded hover:bg-zinc-800 disabled:opacity-30 text-zinc-300"
            >
              <CornerLeftUp className="w-3.5 h-3.5" />
            </button>

            {localJumpOpen ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setLocalJumpOpen(false);
                  void loadLocalDir(localJumpInput);
                }}
                className="flex-1 min-w-0"
              >
                <input
                  autoFocus
                  type="text"
                  value={localJumpInput}
                  onChange={(e) => setLocalJumpInput(e.target.value)}
                  onBlur={() => setLocalJumpOpen(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setLocalJumpOpen(false);
                  }}
                  className="w-full bg-slate-950 border border-emerald-600/80 rounded px-2 py-0.5 text-[11px] text-zinc-100 focus:outline-none"
                />
              </form>
            ) : (
              <div
                onDoubleClick={() => setLocalJumpOpen(true)}
                className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto bg-slate-950 border border-zinc-800 rounded px-1.5 py-0.5"
              >
                {splitBreadcrumbs(localListing?.path ?? "", false).map(
                  (crumb, i, arr) => (
                    <React.Fragment key={crumb.path}>
                      <button
                        type="button"
                        onClick={() => void loadLocalDir(crumb.path)}
                        className={`px-1 rounded hover:bg-zinc-800 truncate max-w-[130px] ${
                          i === arr.length - 1
                            ? "text-zinc-100 font-medium"
                            : "text-zinc-400"
                        }`}
                      >
                        {crumb.label}
                      </button>
                      {i < arr.length - 1 && (
                        <span className="text-zinc-600">/</span>
                      )}
                    </React.Fragment>
                  ),
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => setLocalJumpOpen((v) => !v)}
              title="Jump to Local Path"
              className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              <Navigation className="w-3 h-3" />
            </button>

            <div className="relative w-32 shrink-0">
              <Search className="w-3 h-3 text-zinc-500 absolute left-1.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={localFilter}
                placeholder="Filter..."
                onChange={(e) => setLocalFilter(e.target.value)}
                className="w-full bg-slate-950 border border-zinc-800 focus:border-zinc-600 focus:outline-none rounded pl-5 pr-1.5 py-0.5 text-[11px] text-zinc-200"
              />
            </div>

            <button
              type="button"
              onClick={() => setLocalNewFolderOpen((v) => !v)}
              title="New Local Folder"
              className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              <FolderPlus className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => void loadLocalDir(localListing?.path)}
              title="Refresh Local Directory"
              className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${localLoading ? "animate-spin" : ""}`}
              />
            </button>
          </div>

          {localNewFolderOpen && (
            <form
              onSubmit={submitLocalNewFolder}
              className="px-2.5 py-1.5 bg-zinc-900 border-b border-zinc-800 flex items-center gap-2 font-mono text-xs shrink-0"
            >
              <span className="text-[11px] text-zinc-400">New Folder:</span>
              <input
                autoFocus
                type="text"
                value={localNewFolderName}
                onChange={(e) => setLocalNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setLocalNewFolderOpen(false);
                }}
                placeholder="folder_name"
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

          {/* Local Table */}
          <div className="flex-1 min-h-0 overflow-auto">
            <table className="w-full border-collapse font-mono text-[11px]">
              <thead className="sticky top-0 z-10 bg-zinc-950 border-b border-zinc-800 text-[10px] uppercase text-zinc-500">
                <tr>
                  <th
                    onClick={() => toggleSort("local", "name")}
                    className="px-2.5 py-1.5 text-left cursor-pointer hover:text-zinc-300"
                  >
                    Name{" "}
                    {renderSortArrow(localSortField, localSortDir, "name")}
                  </th>
                  <th
                    onClick={() => toggleSort("local", "size")}
                    className="w-24 px-2 py-1.5 text-right cursor-pointer hover:text-zinc-300"
                  >
                    Size{" "}
                    {renderSortArrow(localSortField, localSortDir, "size")}
                  </th>
                  <th
                    onClick={() => toggleSort("local", "mtime")}
                    className="w-36 px-2.5 py-1.5 text-right cursor-pointer hover:text-zinc-300"
                  >
                    Modified{" "}
                    {renderSortArrow(localSortField, localSortDir, "mtime")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900/70">
                {sortedLocalEntries.map((entry) => {
                  const selected = entry.path === selectedLocalPath;
                  const isRenaming =
                    renamingTarget?.side === "local" &&
                    renamingTarget.entry.path === entry.path;

                  return (
                    <tr
                      key={entry.path}
                      draggable={!isRenaming}
                      onDragStart={(e) => handleRowDragStart(e, "local", entry)}
                      onDragOver={(e) => {
                        if (entry.is_dir_like) {
                          e.preventDefault();
                        }
                      }}
                      onDrop={(e) => {
                        if (entry.is_dir_like) {
                          handlePaneDrop(e, "local", entry.path);
                        }
                      }}
                      onClick={() => setSelectedLocalPath(entry.path)}
                      onDoubleClick={() => {
                        if (entry.is_dir_like) {
                          void loadLocalDir(entry.path);
                        } else if (isConnected && remoteListing) {
                          handleCompareDiff("local", entry);
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelectedLocalPath(entry.path);
                        setContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          side: "local",
                          entry,
                        });
                      }}
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
                              onChange={(e) =>
                                setRenamingTarget({
                                  ...renamingTarget,
                                  value: e.target.value,
                                })
                              }
                              onBlur={() => void commitRename()}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void commitRename();
                                if (e.key === "Escape") setRenamingTarget(null);
                              }}
                              className="flex-1 bg-zinc-900 border border-emerald-500 rounded px-1 py-0 text-[11px] text-zinc-100 focus:outline-none"
                            />
                          ) : (
                            <span className="truncate">{entry.name}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1 text-right text-zinc-500 whitespace-nowrap">
                        {entry.is_dir_like ? "—" : formatBytes(entry.size)}
                      </td>
                      <td className="px-2.5 py-1 text-right text-zinc-500 whitespace-nowrap">
                        {formatMtime(entry.mtime)}
                      </td>
                    </tr>
                  );
                })}
                {sortedLocalEntries.length === 0 && !localLoading && (
                  <tr>
                    <td
                      colSpan={3}
                      className="py-8 text-center text-zinc-600 text-xs"
                    >
                      Directory empty
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Horizontal Drag Splitter */}
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startPaneSplitDrag}
          className="w-1.5 shrink-0 bg-zinc-900 border-x border-zinc-800 hover:bg-emerald-500/40 hover:border-emerald-500/60 cursor-col-resize transition-colors flex items-center justify-center"
        >
          <div className="h-8 w-0.5 bg-zinc-700 rounded-full" />
        </div>

        {/* ===================================================================
            RIGHT PANE: REMOTE LINUX SFTP FILESYSTEM
           =================================================================== */}
        <section
          style={{ width: `${(1 - leftRatio) * 100}%` }}
          onDragOver={(e) => {
            if (!isConnected) return;
            e.preventDefault();
            if (dragOverSide !== "remote") setDragOverSide("remote");
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDragOverSide(null);
            }
          }}
          onDrop={(e) => {
            if (isConnected) handlePaneDrop(e, "remote");
          }}
          className={`flex-1 min-w-[260px] h-full flex flex-col bg-slate-950 transition-colors ${
            dragOverSide === "remote"
              ? "ring-1 ring-inset ring-emerald-500/80 bg-emerald-950/10"
              : ""
          }`}
        >
          {/* Remote Pane Header */}
          <div className="h-8 px-2.5 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between gap-2 shrink-0 font-mono text-xs">
            <div className="flex items-center gap-1.5 text-zinc-200 min-w-0">
              <Server className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="font-semibold text-[11px] uppercase tracking-wider truncate">
                Remote Linux SFTP
                {profile ? ` (${profile.username}@${profile.host})` : ""}
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                disabled={
                  !isConnected || !selectedRemoteEntry || !localListing
                }
                onClick={() => {
                  if (selectedRemoteEntry) {
                    handleTransferEntry("remote", selectedRemoteEntry);
                  }
                }}
                title="Queue Download (Recursive for Directories) to Current Local Folder"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-cyan-700/80 bg-cyan-950/50 hover:bg-cyan-900/60 disabled:opacity-35 disabled:pointer-events-none text-cyan-200 text-[10px]"
              >
                <ArrowLeft className="w-3 h-3" />
                <span>Download</span>
              </button>
            </div>
          </div>

          {!profile ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2.5 p-4 font-mono text-center">
              <span className="text-xs text-zinc-400">
                No workspace profile configured.
              </span>
              <button
                type="button"
                onClick={onCreateProfile}
                className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-semibold text-xs"
              >
                Create Lab Profile
              </button>
            </div>
          ) : !isConnected ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2.5 p-4 font-mono text-center">
              <div className="text-xs text-zinc-400">
                SFTP subsystem offline for{" "}
                <span className="text-zinc-200">
                  {profile.username}@{profile.host}:{profile.port}
                </span>
              </div>
              <button
                type="button"
                onClick={onConnect}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-emerald-700/80 bg-emerald-950/60 hover:bg-emerald-900/60 text-emerald-200 text-xs"
              >
                <Plug className="w-3.5 h-3.5" />
                <span>Connect SSH &amp; Initialize SFTP</span>
              </button>
            </div>
          ) : (
            <>
              {/* Remote Breadcrumbs, Quick Jump & Filter Bar */}
              <div className="px-2 py-1 bg-zinc-900/50 border-b border-zinc-800/90 flex items-center gap-1.5 shrink-0 font-mono text-[11px]">
                <button
                  type="button"
                  disabled={!remoteListing?.parent_path}
                  onClick={() => {
                    if (profileId && remoteListing?.parent_path) {
                      void loadRemoteDir(profileId, remoteListing.parent_path);
                    }
                  }}
                  title="Parent POSIX Directory"
                  className="p-1 rounded hover:bg-zinc-800 disabled:opacity-30 text-zinc-300"
                >
                  <CornerLeftUp className="w-3.5 h-3.5" />
                </button>

                {remoteJumpOpen ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      setRemoteJumpOpen(false);
                      if (profileId) {
                        void loadRemoteDir(
                          profileId,
                          normalizePosixPath(remoteJumpInput),
                        );
                      }
                    }}
                    className="flex-1 min-w-0"
                  >
                    <input
                      autoFocus
                      type="text"
                      value={remoteJumpInput}
                      placeholder="/var/log or ~/workspace"
                      onChange={(e) => setRemoteJumpInput(e.target.value)}
                      onBlur={() => setRemoteJumpOpen(false)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setRemoteJumpOpen(false);
                      }}
                      className="w-full bg-slate-950 border border-emerald-600/80 rounded px-2 py-0.5 text-[11px] text-zinc-100 focus:outline-none"
                    />
                  </form>
                ) : (
                  <div
                    onDoubleClick={() => setRemoteJumpOpen(true)}
                    className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto bg-slate-950 border border-zinc-800 rounded px-1.5 py-0.5"
                  >
                    {splitBreadcrumbs(remoteListing?.path ?? "/", true).map(
                      (crumb, i, arr) => (
                        <React.Fragment key={crumb.path}>
                          <button
                            type="button"
                            onClick={() => {
                              if (profileId) {
                                void loadRemoteDir(profileId, crumb.path);
                              }
                            }}
                            className={`px-1 rounded hover:bg-zinc-800 truncate max-w-[130px] ${
                              i === arr.length - 1
                                ? "text-emerald-300 font-medium"
                                : "text-zinc-400"
                            }`}
                          >
                            {crumb.label}
                          </button>
                          {i < arr.length - 1 && crumb.label !== "/" && (
                            <span className="text-zinc-600">/</span>
                          )}
                        </React.Fragment>
                      ),
                    )}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setRemoteJumpOpen((v) => !v)}
                  title="Quick Path Jump"
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                >
                  <Navigation className="w-3 h-3" />
                </button>

                <div className="relative w-32 shrink-0">
                  <Search className="w-3 h-3 text-zinc-500 absolute left-1.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={remoteFilter}
                    placeholder="Filter..."
                    onChange={(e) => setRemoteFilter(e.target.value)}
                    className="w-full bg-slate-950 border border-zinc-800 focus:border-zinc-600 focus:outline-none rounded pl-5 pr-1.5 py-0.5 text-[11px] text-zinc-200"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setRemoteNewFolderOpen((v) => !v)}
                  title="New Remote POSIX Directory"
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (profileId) {
                      void loadRemoteDir(profileId, remoteListing?.path);
                    }
                  }}
                  title="Refresh SFTP Directory"
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${
                      remoteLoading ? "animate-spin" : ""
                    }`}
                  />
                </button>
              </div>

              {remoteNewFolderOpen && (
                <form
                  onSubmit={submitRemoteNewFolder}
                  className="px-2.5 py-1.5 bg-zinc-900 border-b border-zinc-800 flex items-center gap-2 font-mono text-xs shrink-0"
                >
                  <span className="text-[11px] text-zinc-400">
                    Remote mkdir:
                  </span>
                  <input
                    autoFocus
                    type="text"
                    value={remoteNewFolderName}
                    onChange={(e) => setRemoteNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setRemoteNewFolderOpen(false);
                    }}
                    placeholder="new_dir"
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

              {/* Remote SFTP Table */}
              <div className="flex-1 min-h-0 overflow-auto">
                <table className="w-full border-collapse font-mono text-[11px]">
                  <thead className="sticky top-0 z-10 bg-zinc-950 border-b border-zinc-800 text-[10px] uppercase text-zinc-500">
                    <tr>
                      <th
                        onClick={() => toggleSort("remote", "name")}
                        className="px-2.5 py-1.5 text-left cursor-pointer hover:text-zinc-300"
                      >
                        Name{" "}
                        {renderSortArrow(remoteSortField, remoteSortDir, "name")}
                      </th>
                      <th className="w-32 px-2 py-1.5 text-left">
                        Permissions
                      </th>
                      <th
                        onClick={() => toggleSort("remote", "size")}
                        className="w-24 px-2 py-1.5 text-right cursor-pointer hover:text-zinc-300"
                      >
                        Size{" "}
                        {renderSortArrow(remoteSortField, remoteSortDir, "size")}
                      </th>
                      <th
                        onClick={() => toggleSort("remote", "mtime")}
                        className="w-36 px-2.5 py-1.5 text-right cursor-pointer hover:text-zinc-300"
                      >
                        Modified{" "}
                        {renderSortArrow(
                          remoteSortField,
                          remoteSortDir,
                          "mtime",
                        )}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900/70">
                    {sortedRemoteEntries.map((entry) => {
                      const selected = entry.path === selectedRemotePath;
                      const isRenaming =
                        renamingTarget?.side === "remote" &&
                        renamingTarget.entry.path === entry.path;

                      return (
                        <tr
                          key={entry.path}
                          draggable={!isRenaming}
                          onDragStart={(e) =>
                            handleRowDragStart(e, "remote", entry)
                          }
                          onDragOver={(e) => {
                            if (entry.is_dir_like) {
                              e.preventDefault();
                            }
                          }}
                          onDrop={(e) => {
                            if (entry.is_dir_like) {
                              handlePaneDrop(e, "remote", entry.path);
                            }
                          }}
                          onClick={() => setSelectedRemotePath(entry.path)}
                          onDoubleClick={() => {
                            if (entry.is_dir_like && profileId) {
                              void loadRemoteDir(profileId, entry.path);
                            } else if (!entry.is_dir_like) {
                              handleCompareDiff("remote", entry);
                            }
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setSelectedRemotePath(entry.path);
                            setContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              side: "remote",
                              entry,
                            });
                          }}
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
                                  onChange={(e) =>
                                    setRenamingTarget({
                                      ...renamingTarget,
                                      value: e.target.value,
                                    })
                                  }
                                  onBlur={() => void commitRename()}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") void commitRename();
                                    if (e.key === "Escape")
                                      setRenamingTarget(null);
                                  }}
                                  className="flex-1 bg-zinc-900 border border-emerald-500 rounded px-1 py-0 text-[11px] text-zinc-100 focus:outline-none"
                                />
                              ) : (
                                <span
                                  className={`truncate ${
                                    entry.is_executable
                                      ? "text-emerald-300"
                                      : ""
                                  }`}
                                >
                                  {entry.name}
                                </span>
                              )}
                            </div>
                          </td>
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
                          <td className="px-2 py-1 text-right text-zinc-500 whitespace-nowrap">
                            {entry.is_dir_like ? "—" : formatBytes(entry.size)}
                          </td>
                          <td className="px-2.5 py-1 text-right text-zinc-500 whitespace-nowrap">
                            {formatMtime(entry.mtime)}
                          </td>
                        </tr>
                      );
                    })}
                    {sortedRemoteEntries.length === 0 && !remoteLoading && (
                      <tr>
                        <td
                          colSpan={4}
                          className="py-8 text-center text-zinc-600 text-xs"
                        >
                          Remote directory empty
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>

      {/* Collapsible Async Transfer Queue Drawer */}
      <TransferDrawer
        transfers={transfers}
        isExpanded={drawerExpanded}
        onToggleExpanded={() => setDrawerExpanded((v) => !v)}
        onCancelTransfer={(id) => void transferCancel(id)}
        onClearFinished={() => {
          void transferClearFinished().then(() => {
            setTransfers((prev) =>
              prev.filter(
                (t) => t.status === "in_progress" || t.status === "queued",
              ),
            );
          });
        }}
      />

      {/* Right-Click Context Menu */}
      <ExplorerContextMenu
        menu={contextMenu}
        canTransfer={Boolean(isConnected && localListing && remoteListing)}
        hasActiveTerminal={hasActiveTerminal}
        onClose={() => setContextMenu(null)}
        onTransfer={handleTransferEntry}
        onCompareDiff={handleCompareDiff}
        onToggleExecutable={(entry) => void handleToggleExecutable(entry)}
        onCopyPath={(p) => {
          void navigator.clipboard.writeText(p).catch(() => {});
        }}
        onSendCdToTerminal={handleSendCd}
        onOpenInVscode={(p) => void handleOpenVscode(p)}
        onStartRename={(side, entry) =>
          setRenamingTarget({ side, entry, value: entry.name })
        }
        onRequestDelete={(side, entry) => setPendingDelete({ side, entry })}
      />

      {/* Side-by-Side Diff & SHA-256 Modal */}
      {profileId && diffTarget && (
        <DiffModal
          isOpen={true}
          profileId={profileId}
          localPath={diffTarget.localPath}
          remotePath={diffTarget.remotePath}
          onClose={() => setDiffTarget(null)}
          onUploadLocalToRemote={(loc, rem) => void handleQueueUpload(loc, rem)}
          onDownloadRemoteToLocal={(rem, loc) =>
            void handleQueueDownload(rem, loc)
          }
        />
      )}
    </div>
  );
};
