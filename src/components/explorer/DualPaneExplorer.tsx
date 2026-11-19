import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Plug } from "lucide-react";
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
  ExplorerContextMenu,
  type ContextMenuState,
} from "./ExplorerContextMenu";
import { TransferDrawer } from "./TransferDrawer";
import { DiffModal } from "./DiffModal";
import { FilePane, type PaneSide } from "./FilePane";
import { useFilePaneState } from "./useFilePaneState";
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

  // Pane listings
  const [localListing, setLocalListing] = useState<DirListing | null>(null);
  const [remoteListing, setRemoteListing] = useState<DirListing | null>(null);

  // Shared pane state hooks
  const localPane = useFilePaneState(localListing, setLocalListing);
  const remotePane = useFilePaneState(remoteListing, setRemoteListing);

  // Inline Rename & Delete Confirmation
  const [renamingTarget, setRenamingTarget] = useState<{
    side: PaneSide;
    entry: FsEntry;
    value: string;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    side: PaneSide;
    entry: FsEntry;
  } | null>(null);

  // Drag & Drop Highlight
  const [dragOverSide, setDragOverSide] = useState<PaneSide | null>(null);

  // Context Menu & Diff Modal
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [diffTarget, setDiffTarget] = useState<{
    localPath: string;
    remotePath: string;
  } | null>(null);

  // Transfer Queue
  const [transfers, setTransfers] = useState<TransferProgressEvent[]>([]);
  const [drawerExpanded, setDrawerExpanded] = useState(false);

  // ---------------------------------------------------------------------------
  // Directory loading
  // ---------------------------------------------------------------------------

  const loadLocalDir = useCallback(
    async (targetPath?: string) => {
      localPane.setLoading(true);
      try {
        const res = await fsLocalListDir(targetPath);
        setLocalListing(res);
        localPane.setJumpInput(res.path);
      } catch (err) {
        onNotifyError(formatError(err));
      } finally {
        localPane.setLoading(false);
      }
    },
    [onNotifyError, localPane.setLoading, localPane.setJumpInput],
  );

  const loadRemoteDir = useCallback(
    async (pid: string, targetPath?: string) => {
      remotePane.setLoading(true);
      try {
        const res = await sftpListDir(pid, targetPath);
        setRemoteListing(res);
        remotePane.setJumpInput(res.path);
      } catch (err) {
        onNotifyError(formatError(err));
      } finally {
        remotePane.setLoading(false);
      }
    },
    [onNotifyError, remotePane.setLoading, remotePane.setJumpInput],
  );

  // Navigate panes when profile changes
  useEffect(() => {
    const preferred = profile?.local_root_path?.trim() || undefined;
    void loadLocalDir(preferred);
    localPane.setSelectedPath(null);
  }, [profile?.id, profile?.local_root_path, loadLocalDir]);

  useEffect(() => {
    if (!profileId || !isConnected) {
      setRemoteListing(null);
      remotePane.setSelectedPath(null);
      return;
    }
    const preferred = profile?.remote_root_path?.trim() || undefined;
    void loadRemoteDir(profileId, preferred);
  }, [profileId, isConnected, profile?.remote_root_path, loadRemoteDir]);

  // Refresh remote pane after sync batches
  useEffect(() => {
    if (!syncRefreshTick || !profileId || !isConnected || !remotePane.pathRef.current) return;
    void loadRemoteDir(profileId, remotePane.pathRef.current);
  }, [syncRefreshTick, profileId, isConnected, loadRemoteDir, remotePane.pathRef]);

  // Follow Terminal CWD (OSC 7)
  useEffect(() => {
    if (!followedRemoteDir || !profileId || !isConnected) return;
    const normalized = normalizePosixPath(followedRemoteDir);
    if (normalized && normalized !== remotePane.pathRef.current) {
      void loadRemoteDir(profileId, normalized);
    }
  }, [followedRemoteDir, profileId, isConnected, loadRemoteDir, remotePane.pathRef]);

  // Subscribe to transfer queue
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
        if (idx === -1) return [ev, ...prev];
        const copy = [...prev];
        copy[idx] = ev;
        return copy;
      });

      if (ev.status === "completed") {
        if (ev.direction === "download") {
          void loadLocalDir(localPane.pathRef.current);
        } else if (ev.direction === "upload" && ev.profile_id === profileId) {
          void loadRemoteDir(ev.profile_id, remotePane.pathRef.current);
        }
      }
    }).catch((err) => {
      if (mounted) onNotifyError(formatError(err));
    });

    return () => {
      mounted = false;
    };
  }, [loadLocalDir, loadRemoteDir, onNotifyError, profileId, localPane.pathRef, remotePane.pathRef]);

  // ---------------------------------------------------------------------------
  // Transfer queue helpers
  // ---------------------------------------------------------------------------

  const handleQueueUpload = useCallback(
    async (localSourcePath: string, remoteDestPath: string) => {
      if (!profileId || !isConnected) return;
      try {
        setDrawerExpanded(true);
        await transferEnqueue(profileId, "upload", localSourcePath, normalizePosixPath(remoteDestPath));
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
        await transferEnqueue(profileId, "download", normalizePosixPath(remoteSourcePath), localDestPath);
      } catch (err) {
        onNotifyError(formatError(err));
      }
    },
    [isConnected, onNotifyError, profileId],
  );

  const handleTransferEntry = (side: PaneSide, entry: FsEntry) => {
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

  // ---------------------------------------------------------------------------
  // Drag & drop
  // ---------------------------------------------------------------------------

  const handleRowDragStart = (e: React.DragEvent, side: PaneSide, entry: FsEntry) => {
    const payload: DraggedPayload = { side, entry };
    e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "copy";
  };

  const handlePaneDrop = (
    e: React.DragEvent,
    targetSide: PaneSide,
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

  // ---------------------------------------------------------------------------
  // VS Code, folder, rename, delete, chmod, diff, cd
  // ---------------------------------------------------------------------------

  const handleOpenVscode = async (pathOverride?: string) => {
    const target = pathOverride || profile?.local_root_path?.trim() || localListing?.path || "";
    if (!target) return;
    try {
      await openInVscode(target);
    } catch (err) {
      onNotifyError(formatError(err));
    }
  };

  const submitLocalNewFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!localListing || !localPane.newFolderName.trim()) return;
    try {
      const target = joinLocalPath(localListing.path, localPane.newFolderName.trim());
      await fsLocalCreateDir(target);
      localPane.setNewFolderName("");
      localPane.setNewFolderOpen(false);
      await loadLocalDir(localListing.path);
    } catch (err) {
      onNotifyError(formatError(err));
    }
  };

  const submitRemoteNewFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profileId || !remoteListing || !remotePane.newFolderName.trim()) return;
    try {
      const target = joinPosixPath(remoteListing.path, remotePane.newFolderName.trim());
      await sftpCreateDir(profileId, target);
      remotePane.setNewFolderName("");
      remotePane.setNewFolderOpen(false);
      await loadRemoteDir(profileId, remoteListing.path);
    } catch (err) {
      onNotifyError(formatError(err));
    }
  };

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

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { side, entry } = pendingDelete;
    setPendingDelete(null);

    try {
      if (side === "local" && localListing) {
        await fsLocalDelete(entry.path);
        if (localPane.selectedPath === entry.path) localPane.setSelectedPath(null);
        await loadLocalDir(localListing.path);
      } else if (side === "remote" && profileId && remoteListing) {
        await sftpDelete(profileId, entry.path, true);
        if (remotePane.selectedPath === entry.path) remotePane.setSelectedPath(null);
        await loadRemoteDir(profileId, remoteListing.path);
      }
    } catch (err) {
      onNotifyError(formatError(err));
    }
  };

  const handleToggleExecutable = async (entry: FsEntry) => {
    if (!profileId || !remoteListing) return;
    const currentMode = entry.mode ?? 0o644;
    const nextMode = entry.is_executable ? currentMode & ~0o111 : currentMode | 0o111;
    try {
      await sftpChmod(profileId, entry.path, nextMode);
      await loadRemoteDir(profileId, remoteListing.path);
    } catch (err) {
      onNotifyError(formatError(err));
    }
  };

  const handleCompareDiff = (side: PaneSide, entry: FsEntry) => {
    if (!localListing || !remoteListing) return;
    if (side === "local") {
      const pairedRemote =
        remotePane.selectedEntry && !remotePane.selectedEntry.is_dir_like
          ? remotePane.selectedEntry.path
          : joinPosixPath(remoteListing.path, entry.name);
      setDiffTarget({ localPath: entry.path, remotePath: pairedRemote });
    } else {
      const pairedLocal =
        localPane.selectedEntry && !localPane.selectedEntry.is_dir_like
          ? localPane.selectedEntry.path
          : joinLocalPath(localListing.path, entry.name);
      setDiffTarget({ localPath: pairedLocal, remotePath: entry.path });
    }
  };

  const handleSendCd = (_side: PaneSide, entry: FsEntry) => {
    const dirPosix = entry.is_dir_like
      ? normalizePosixPath(entry.path)
      : normalizePosixPath(remoteListing?.path ?? "/");
    const escaped = `'${dirPosix.replace(/'/g, "'\\''")}'`;
    onSendCommandToTerminal(`cd ${escaped}\n`);
  };

  // ---------------------------------------------------------------------------
  // Splitter drag
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="h-full w-full flex flex-col bg-slate-950 overflow-hidden select-none">
      {/* Delete Confirmation Banner */}
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
      <div ref={splitContainerRef} className="flex-1 min-h-0 flex overflow-hidden">
        {/* LEFT: Local */}
        <FilePane
          side="local"
          pane={localPane}
          remoteConnected={isConnected}
          widthPercent={leftRatio * 100}
          emptyMessage="Directory empty"
          dragOver={dragOverSide === "local"}
          renamingTarget={renamingTarget}
          onNavigate={(p) => void loadLocalDir(p)}
          onRefresh={() => void loadLocalDir(localListing?.path)}
          onSubmitNewFolder={submitLocalNewFolder}
          onRowDoubleClick={(entry) => {
            if (entry.is_dir_like) {
              void loadLocalDir(entry.path);
            } else if (isConnected && remoteListing) {
              handleCompareDiff("local", entry);
            }
          }}
          onRowContextMenu={(e, entry) => {
            e.preventDefault();
            localPane.setSelectedPath(entry.path);
            setContextMenu({ x: e.clientX, y: e.clientY, side: "local", entry });
          }}
          onRowDragStart={(e, entry) => handleRowDragStart(e, "local", entry)}
          onRowDragOver={(e, entry) => {
            if (entry.is_dir_like) e.preventDefault();
          }}
          onRowDrop={(e, entry) => {
            if (entry.is_dir_like) handlePaneDrop(e, "local", entry.path);
          }}
          onPaneDragOver={(e) => {
            e.preventDefault();
            if (dragOverSide !== "local") setDragOverSide("local");
          }}
          onPaneDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverSide(null);
          }}
          onPaneDrop={(e) => handlePaneDrop(e, "local")}
          onRenameChange={(v) => renamingTarget && setRenamingTarget({ ...renamingTarget, value: v })}
          onCommitRename={() => void commitRename()}
          onCancelRename={() => setRenamingTarget(null)}
          onOpenVscode={() => void handleOpenVscode()}
          onQueueUpload={
            localPane.selectedEntry && remoteListing
              ? () => handleTransferEntry("local", localPane.selectedEntry!)
              : undefined
          }
          uploadDisabled={!isConnected || !localPane.selectedEntry || !remoteListing}
        />

        {/* Splitter */}
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startPaneSplitDrag}
          className="w-1.5 shrink-0 bg-zinc-900 border-x border-zinc-800 hover:bg-emerald-500/40 hover:border-emerald-500/60 cursor-col-resize transition-colors flex items-center justify-center"
        >
          <div className="h-8 w-0.5 bg-zinc-700 rounded-full" />
        </div>

        {/* RIGHT: Remote */}
        {!profile ? (
          <section className="flex-1 min-w-[260px] h-full flex flex-col bg-slate-950 items-center justify-center gap-2.5 p-4 font-mono text-center">
            <span className="text-xs text-zinc-400">No workspace profile configured.</span>
            <button
              type="button"
              onClick={onCreateProfile}
              className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-semibold text-xs"
            >
              Create Lab Profile
            </button>
          </section>
        ) : (
          <FilePane
            side="remote"
            pane={remotePane}
            profileLabel={`${profile.username}@${profile.host}:${profile.port}`}
            remoteConnected={isConnected}
            widthPercent={(1 - leftRatio) * 100}
            emptyMessage="Remote directory empty"
            showPermissions
            dragOver={dragOverSide === "remote"}
            renamingTarget={renamingTarget}
            onNavigate={(p) => profileId && void loadRemoteDir(profileId, p)}
            onRefresh={() => profileId && void loadRemoteDir(profileId, remoteListing?.path)}
            onSubmitNewFolder={submitRemoteNewFolder}
            onRowDoubleClick={(entry) => {
              if (entry.is_dir_like && profileId) {
                void loadRemoteDir(profileId, entry.path);
              } else if (!entry.is_dir_like) {
                handleCompareDiff("remote", entry);
              }
            }}
            onRowContextMenu={(e, entry) => {
              e.preventDefault();
              remotePane.setSelectedPath(entry.path);
              setContextMenu({ x: e.clientX, y: e.clientY, side: "remote", entry });
            }}
            onRowDragStart={(e, entry) => handleRowDragStart(e, "remote", entry)}
            onRowDragOver={(e, entry) => {
              if (entry.is_dir_like) e.preventDefault();
            }}
            onRowDrop={(e, entry) => {
              if (entry.is_dir_like) handlePaneDrop(e, "remote", entry.path);
            }}
            onPaneDragOver={(e) => {
              if (!isConnected) return;
              e.preventDefault();
              if (dragOverSide !== "remote") setDragOverSide("remote");
            }}
            onPaneDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverSide(null);
            }}
            onPaneDrop={(e) => {
              if (isConnected) handlePaneDrop(e, "remote");
            }}
            onRenameChange={(v) => renamingTarget && setRenamingTarget({ ...renamingTarget, value: v })}
            onCommitRename={() => void commitRename()}
            onCancelRename={() => setRenamingTarget(null)}
            onQueueDownload={
              remotePane.selectedEntry && localListing
                ? () => handleTransferEntry("remote", remotePane.selectedEntry!)
                : undefined
            }
            downloadDisabled={!isConnected || !remotePane.selectedEntry || !localListing}
            connectPrompt={
              <>
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
              </>
            }
          />
        )}
      </div>

      {/* Transfer Queue Drawer */}
      <TransferDrawer
        transfers={transfers}
        isExpanded={drawerExpanded}
        onToggleExpanded={() => setDrawerExpanded((v) => !v)}
        onCancelTransfer={(id) => void transferCancel(id)}
        onClearFinished={() => {
          void transferClearFinished().then(() => {
            setTransfers((prev) =>
              prev.filter((t) => t.status === "in_progress" || t.status === "queued"),
            );
          });
        }}
      />

      {/* Context Menu */}
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
        onStartRename={(side, entry) => setRenamingTarget({ side, entry, value: entry.name })}
        onRequestDelete={(side, entry) => setPendingDelete({ side, entry })}
      />

      {/* Diff Modal */}
      {profileId && diffTarget && (
        <DiffModal
          isOpen={true}
          profileId={profileId}
          localPath={diffTarget.localPath}
          remotePath={diffTarget.remotePath}
          onClose={() => setDiffTarget(null)}
          onUploadLocalToRemote={(loc, rem) => void handleQueueUpload(loc, rem)}
          onDownloadRemoteToLocal={(rem, loc) => void handleQueueDownload(rem, loc)}
        />
      )}
    </div>
  );
};
