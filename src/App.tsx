import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import { TopBar } from "./components/TopBar";
import { SyncControlBar } from "./components/sync/SyncControlBar";
import { DualPaneExplorer } from "./components/explorer/DualPaneExplorer";
import { MacroBar } from "./components/macros/MacroBar";
import { DEFAULT_CLIENT_MACROS } from "./components/macros/MacroEditorModal";
import { ProfileManagerModal } from "./components/ProfileManagerModal";
import { HostKeyModal } from "./components/HostKeyModal";
import { TerminalDock } from "./components/terminal/TerminalDock";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import {
  formatError,
  getStorageInfo,
  listProfiles,
  onHostKeyVerify,
  onPtyClosed,
  onSshStateChanged,
  onSyncBatchLogged,
  onSyncStatusChanged,
  OSC7_PROMPT_HOOK_SNIPPET,
  profileUpdateMacros,
  ptyWrite,
  reconcileWorkspace,
  sshConnect,
  sshDisconnect,
  sshGetState,
  sshListStates,
  sshRespondHostKey,
  syncClearActivityLog,
  syncFlushPending,
  syncGetActivityLog,
  syncGetStatus,
  syncRetry,
  syncUpdatePolicy,
  uiStateGet,
  uiStateSave,
} from "./lib/ipc";
import type {
  ConnectionStatusPayload,
  HostKeyPromptPayload,
  ProfileMacro,
  ReconcileReport,
  StorageInfo,
  SyncBatchLogEntry,
  SyncStatusPayload,
  TerminalTabModel,
  WorkspaceProfile,
} from "./types/labbridge";

export const App: React.FC = () => {
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [profiles, setProfiles] = useState<WorkspaceProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    null,
  );
  const [connectionStates, setConnectionStates] = useState<
    Record<string, ConnectionStatusPayload>
  >({});

  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileModalCreateMode, setProfileModalCreateMode] = useState(false);
  const [hostKeyQueue, setHostKeyQueue] = useState<HostKeyPromptPayload[]>([]);
  const [bannerError, setBannerError] = useState<string | null>(null);

  // Sync Engine state (Phase 3)
  const [syncStatuses, setSyncStatuses] = useState<
    Record<string, SyncStatusPayload>
  >({});
  const [syncLogsByProfile, setSyncLogsByProfile] = useState<
    Record<string, SyncBatchLogEntry[]>
  >({});
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [reconcileReport, setReconcileReport] =
    useState<ReconcileReport | null>(null);
  const [syncRefreshTick, setSyncRefreshTick] = useState(0);

  // Persisted Layout & Terminal-Explorer Sync state (Phase 4)
  const [uiBootstrapped, setUiBootstrapped] = useState(false);
  const [explorerLeftRatio, setExplorerLeftRatio] = useState<number>(0.5);
  const [dockHeight, setDockHeight] = useState<number>(360);
  const [isDockMaximized, setIsDockMaximized] = useState(false);
  const [followTerminalCwd, setFollowTerminalCwd] = useState(false);
  const [runningMacroId, setRunningMacroId] = useState<string | null>(null);

  // Terminal multi-tab state & per-tab OSC 7 working directories
  const [tabs, setTabs] = useState<TerminalTabModel[]>([]);
  const [activeTabUiId, setActiveTabUiId] = useState<string | null>(null);
  const [tabRemoteCwds, setTabRemoteCwds] = useState<Record<string, string>>(
    {},
  );
  const tabCounterRef = useRef<number>(1);
  const isDraggingRef = useRef(false);
  const intentionalDisconnectsRef = useRef<Set<string>>(new Set());

  const selectedProfile =
    profiles.find((p) => p.id === selectedProfileId) ?? null;
  const activeStatus = selectedProfileId
    ? (connectionStates[selectedProfileId] ?? null)
    : null;
  const isSelectedConnected =
    activeStatus?.connection_state.state === "Connected";

  const refreshProfiles = useCallback(
    async (preferredId?: string | null) => {
      const loaded = await listProfiles();
      setProfiles(loaded);

      setSelectedProfileId((prev) => {
        if (preferredId !== undefined) {
          if (preferredId && loaded.some((p) => p.id === preferredId)) {
            return preferredId;
          }
          return loaded[0]?.id ?? null;
        }
        if (prev && loaded.some((p) => p.id === prev)) {
          return prev;
        }
        return loaded[0]?.id ?? null;
      });
    },
    [],
  );

  // Bootstrap Storage, Saved UI State, Profiles & Backend Event Subscriptions
  useEffect(() => {
    void (async () => {
      try {
        const [info, states, savedUi, loadedProfiles] = await Promise.all([
          getStorageInfo(),
          sshListStates(),
          uiStateGet(),
          listProfiles(),
        ]);

        setStorageInfo(info);
        setConnectionStates(states);
        setProfiles(loadedProfiles);

        setExplorerLeftRatio(savedUi.explorer_left_ratio ?? 0.5);
        setDockHeight(savedUi.terminal_dock_height ?? 360);
        setIsDockMaximized(Boolean(savedUi.terminal_dock_maximized));
        setFollowTerminalCwd(Boolean(savedUi.follow_terminal_cwd));

        const initialPid =
          savedUi.last_active_profile_id &&
          loadedProfiles.some((p) => p.id === savedUi.last_active_profile_id)
            ? savedUi.last_active_profile_id
            : (loadedProfiles[0]?.id ?? null);
        setSelectedProfileId(initialPid);
        setUiBootstrapped(true);
      } catch (err) {
        setBannerError(formatError(err));
        setUiBootstrapped(true);
      }
    })();

    const unlistenPromises = [
      onSshStateChanged((payload) => {
        setConnectionStates((prev) => ({
          ...prev,
          [payload.profile_id]: payload,
        }));

        // Mark active terminal tabs with [Disconnected - Press Enter to Reopen Shell]
        // when VPN blips / transport enters Reconnecting or drops unexpectedly
        if (
          payload.connection_state.state === "Reconnecting" ||
          (payload.connection_state.state === "Disconnected" &&
            !intentionalDisconnectsRef.current.has(payload.profile_id))
        ) {
          setTabs((prev) =>
            prev.map((tab) =>
              tab.profileId === payload.profile_id &&
              (tab.status === "ready" || tab.status === "opening")
                ? { ...tab, ptyTabId: null, status: "disconnected" }
                : tab,
            ),
          );
        }
      }),
      onHostKeyVerify((prompt) => {
        setHostKeyQueue((prev) => [...prev, prompt]);
      }),
      onPtyClosed((closed) => {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.ptyTabId === closed.tab_id
              ? {
                  ...tab,
                  ptyTabId: null,
                  status: "exited",
                  exitCode: closed.exit_code ?? null,
                }
              : tab,
          ),
        );
      }),
      onSyncStatusChanged((payload) => {
        setSyncStatuses((prev) => ({
          ...prev,
          [payload.profile_id]: payload,
        }));
      }),
      onSyncBatchLogged((entry) => {
        setSyncLogsByProfile((prev) => {
          const existing = prev[entry.profile_id] ?? [];
          const next = [entry, ...existing].slice(0, 200);
          return { ...prev, [entry.profile_id]: next };
        });
        if (entry.success) {
          setSyncRefreshTick((t) => t + 1);
        }
      }),
    ];

    return () => {
      void Promise.all(unlistenPromises).then((fns) =>
        fns.forEach((fn) => fn()),
      );
    };
  }, []);

  // Persist pane split ratios, dock height, follow toggle & active profile cleanly
  const latestUiStateRef = useRef({
    last_active_profile_id: selectedProfileId,
    explorer_left_ratio: explorerLeftRatio,
    terminal_dock_height: Math.round(dockHeight),
    terminal_dock_maximized: isDockMaximized,
    follow_terminal_cwd: followTerminalCwd,
  });
  latestUiStateRef.current = {
    last_active_profile_id: selectedProfileId,
    explorer_left_ratio: explorerLeftRatio,
    terminal_dock_height: Math.round(dockHeight),
    terminal_dock_maximized: isDockMaximized,
    follow_terminal_cwd: followTerminalCwd,
  };

  useEffect(() => {
    if (!uiBootstrapped) return;
    const timer = window.setTimeout(() => {
      void uiStateSave(latestUiStateRef.current).catch(() => {});
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    uiBootstrapped,
    selectedProfileId,
    explorerLeftRatio,
    dockHeight,
    isDockMaximized,
    followTerminalCwd,
  ]);

  useEffect(() => {
    const flushOnUnload = () => {
      void uiStateSave(latestUiStateRef.current).catch(() => {});
    };
    window.addEventListener("beforeunload", flushOnUnload);
    return () => window.removeEventListener("beforeunload", flushOnUnload);
  }, []);

  // Fetch Sync status & activity history when selected profile changes
  useEffect(() => {
    if (!selectedProfileId) return;
    const pid = selectedProfileId;
    void Promise.all([syncGetStatus(pid), syncGetActivityLog(pid)])
      .then(([st, logs]) => {
        setSyncStatuses((prev) => ({ ...prev, [pid]: st }));
        setSyncLogsByProfile((prev) => ({ ...prev, [pid]: logs }));
      })
      .catch(() => {});
  }, [selectedProfileId]);

  const spawnTerminalTabForProfile = useCallback(
    (
      profile: WorkspaceProfile,
      opts?: { title?: string; macroId?: string; initialCommand?: string },
    ) => {
      const seq = tabCounterRef.current++;
      const uiId = `ui-pty-${Date.now()}-${seq}`;
      const newTab: TerminalTabModel = {
        uiId,
        ptyTabId: null,
        profileId: profile.id,
        profileName: profile.name,
        title: opts?.title ?? `${profile.username}@${profile.host} #${seq}`,
        status: "opening",
        renderer: "webgl",
        cols: 80,
        rows: 24,
        macroId: opts?.macroId,
        initialCommand: opts?.initialCommand,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabUiId(uiId);
      return uiId;
    },
    [],
  );

  const handleOpenNewTerminal = useCallback(() => {
    if (!selectedProfile || !isSelectedConnected) return;
    spawnTerminalTabForProfile(selectedProfile);
  }, [isSelectedConnected, selectedProfile, spawnTerminalTabForProfile]);

  const handleCloseTab = useCallback((uiId: string) => {
    setTabRemoteCwds((prev) => {
      const next = { ...prev };
      delete next[uiId];
      return next;
    });

    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.uiId === uiId);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.uiId !== uiId);
      setActiveTabUiId((currentActive) => {
        if (currentActive !== uiId) return currentActive;
        if (next.length === 0) return null;
        const fallback = next[Math.min(idx, next.length - 1)];
        return fallback.uiId;
      });
      return next;
    });
  }, []);

  const handleConnect = useCallback(async () => {
    if (!selectedProfile) return;
    setBannerError(null);
    const targetProfile = selectedProfile;
    intentionalDisconnectsRef.current.delete(targetProfile.id);

    try {
      const status = await sshConnect(targetProfile.id);
      setConnectionStates((prev) => ({
        ...prev,
        [targetProfile.id]: status,
      }));

      setTabs((prev) => {
        const hasTabForProfile = prev.some(
          (t) => t.profileId === targetProfile.id,
        );
        if (hasTabForProfile) {
          return prev;
        }
        const seq = tabCounterRef.current++;
        const uiId = `ui-pty-${Date.now()}-${seq}`;
        const initialTab: TerminalTabModel = {
          uiId,
          ptyTabId: null,
          profileId: targetProfile.id,
          profileName: targetProfile.name,
          title: `${targetProfile.username}@${targetProfile.host} #${seq}`,
          status: "opening",
          renderer: "webgl",
          cols: 80,
          rows: 24,
        };
        setActiveTabUiId(uiId);
        return [...prev, initialTab];
      });
    } catch (err) {
      setBannerError(formatError(err));
    }
  }, [selectedProfile]);

  // Ensures SSH session is connected before reopening a disconnected shell tab on Enter
  const handleEnsureConnected = useCallback(
    async (profileId: string): Promise<boolean> => {
      try {
        const st = await sshGetState(profileId);
        if (st.connection_state.state === "Connected") {
          return true;
        }
        intentionalDisconnectsRef.current.delete(profileId);
        const connected = await sshConnect(profileId);
        setConnectionStates((prev) => ({
          ...prev,
          [profileId]: connected,
        }));
        return connected.connection_state.state === "Connected";
      } catch (err) {
        setBannerError(formatError(err));
        return false;
      }
    },
    [],
  );

  const handleDisconnect = useCallback(async () => {
    if (!selectedProfileId) return;
    setBannerError(null);
    const pid = selectedProfileId;
    intentionalDisconnectsRef.current.add(pid);

    setTabs((prev) => {
      const remaining = prev.filter((t) => t.profileId !== pid);
      setActiveTabUiId((curr) =>
        remaining.some((t) => t.uiId === curr)
          ? curr
          : (remaining[remaining.length - 1]?.uiId ?? null),
      );
      return remaining;
    });

    setHostKeyQueue((prev) => prev.filter((p) => p.profile_id !== pid));

    try {
      const status = await sshDisconnect(pid);
      setConnectionStates((prev) => ({
        ...prev,
        [pid]: status,
      }));
    } catch (err) {
      setBannerError(formatError(err));
    }
  }, [selectedProfileId]);

  const handleRespondHostKey = useCallback(
    async (requestId: string, accept: boolean) => {
      setHostKeyQueue((prev) =>
        prev.filter((item) => item.request_id !== requestId),
      );
      try {
        await sshRespondHostKey(requestId, accept);
      } catch (err) {
        setBannerError(formatError(err));
      }
    },
    [],
  );

  const activeReadyTerminalTab =
    tabs.find(
      (t) =>
        t.uiId === activeTabUiId && t.status === "ready" && Boolean(t.ptyTabId),
    ) ??
    tabs.find(
      (t) =>
        t.profileId === selectedProfileId &&
        t.status === "ready" &&
        Boolean(t.ptyTabId),
    ) ??
    null;

  const handleSendCommandToTerminal = useCallback(
    (command: string) => {
      if (!activeReadyTerminalTab?.ptyTabId) {
        if (selectedProfile && isSelectedConnected) {
          spawnTerminalTabForProfile(selectedProfile, {
            initialCommand: command,
          });
          return;
        }
        setBannerError(
          "No active terminal shell open. Open a shell tab (Ctrl+Shift+T) first.",
        );
        return;
      }
      setActiveTabUiId(activeReadyTerminalTab.uiId);
      const encoded = new TextEncoder().encode(command);
      void ptyWrite(activeReadyTerminalTab.ptyTabId, encoded).catch((err) => {
        setBannerError(formatError(err));
      });
    },
    [
      activeReadyTerminalTab,
      isSelectedConnected,
      selectedProfile,
      spawnTerminalTabForProfile,
    ],
  );

  // Per-Profile Hardware & Build Macro Execution
  const handleTriggerMacro = useCallback(
    async (macro: ProfileMacro) => {
      if (!selectedProfile || !isSelectedConnected || runningMacroId) return;
      setBannerError(null);

      if (macro.flush_sync_before_run) {
        setRunningMacroId(macro.id);
        try {
          await syncFlushPending(selectedProfile.id);
        } catch (err) {
          setBannerError(formatError(err));
          setRunningMacroId(null);
          return;
        }
        setRunningMacroId(null);
      }

      const cmdLine = macro.command.endsWith("\n")
        ? macro.command
        : `${macro.command}\n`;

      if (macro.target_mode === "active_terminal") {
        handleSendCommandToTerminal(cmdLine);
        return;
      }

      // Run in Dedicated Output Tab
      const existingDedicated = tabs.find(
        (t) =>
          t.profileId === selectedProfile.id &&
          t.macroId === macro.id &&
          t.status === "ready" &&
          Boolean(t.ptyTabId),
      );

      if (existingDedicated?.ptyTabId) {
        setActiveTabUiId(existingDedicated.uiId);
        const encoded = new TextEncoder().encode(cmdLine);
        void ptyWrite(existingDedicated.ptyTabId, encoded).catch((err) => {
          setBannerError(formatError(err));
        });
      } else {
        // Remove any stale exited/disconnected dedicated tab for this macro first
        setTabs((prev) =>
          prev.filter(
            (t) =>
              !(
                t.profileId === selectedProfile.id &&
                t.macroId === macro.id &&
                t.status !== "ready"
              ),
          ),
        );
        spawnTerminalTabForProfile(selectedProfile, {
          title: `[${macro.label}]`,
          macroId: macro.id,
          initialCommand: cmdLine,
        });
      }
    },
    [
      handleSendCommandToTerminal,
      isSelectedConnected,
      runningMacroId,
      selectedProfile,
      spawnTerminalTabForProfile,
      tabs,
    ],
  );

  const handleTriggerMacroIndex = useCallback(
    (index: number) => {
      if (!selectedProfile || !isSelectedConnected) return;
      const list =
        selectedProfile.macros && selectedProfile.macros.length > 0
          ? selectedProfile.macros
          : DEFAULT_CLIENT_MACROS;
      const target = list[index];
      if (target) {
        void handleTriggerMacro(target);
      }
    },
    [handleTriggerMacro, isSelectedConnected, selectedProfile],
  );

  const handleSaveProfileMacros = useCallback(
    async (macros: ProfileMacro[]) => {
      if (!selectedProfileId) return;
      try {
        await profileUpdateMacros(selectedProfileId, macros);
        await refreshProfiles(selectedProfileId);
      } catch (err) {
        setBannerError(formatError(err));
      }
    },
    [refreshProfiles, selectedProfileId],
  );

  const handleInjectOsc7Hook = useCallback(() => {
    setFollowTerminalCwd(true);
    handleSendCommandToTerminal(OSC7_PROMPT_HOOK_SNIPPET);
  }, [handleSendCommandToTerminal]);

  // Global workbench shortcuts via extracted hook (Alt+1..5, Ctrl+,, Ctrl+J, Ctrl+Shift+T/W)
  useKeyboardShortcuts({
    onTriggerMacroIndex: handleTriggerMacroIndex,
    onOpenSettings: () => {
      setProfileModalCreateMode(false);
      setProfileModalOpen(true);
    },
    onToggleDockMaximize: () => setIsDockMaximized((v) => !v),
    onOpenNewTerminal: handleOpenNewTerminal,
    onCloseActiveTab: () => {
      if (activeTabUiId) handleCloseTab(activeTabUiId);
    },
    hasActiveTab: Boolean(activeTabUiId),
  });

  // Vertical dock splitter drag handler
  const startSplitterDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDockMaximized) return;
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = "row-resize";

    const onMove = (moveEv: PointerEvent) => {
      if (!isDraggingRef.current) return;
      const minHeight = 160;
      const maxHeight = Math.max(220, window.innerHeight - 180);
      const nextHeight = Math.min(
        maxHeight,
        Math.max(minHeight, window.innerHeight - moveEv.clientY),
      );
      setDockHeight(nextHeight);
    };

    const onUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // TerminalPane status callbacks
  const handlePtyOpened = useCallback(
    (uiId: string, ptyTabId: string, cols: number, rows: number) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.uiId === uiId
            ? { ...t, ptyTabId, status: "ready", cols, rows }
            : t,
        ),
      );
    },
    [],
  );

  const handlePtyOpenError = useCallback(
    (uiId: string, errorMessage: string) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.uiId === uiId ? { ...t, status: "error", errorMessage } : t,
        ),
      );
    },
    [],
  );

  const handleDimensionsChange = useCallback(
    (uiId: string, cols: number, rows: number) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.uiId === uiId && (t.cols !== cols || t.rows !== rows)
            ? { ...t, cols, rows }
            : t,
        ),
      );
    },
    [],
  );

  const handleRendererChange = useCallback(
    (uiId: string, renderer: "webgl" | "canvas") => {
      setTabs((prev) =>
        prev.map((t) =>
          t.uiId === uiId && t.renderer !== renderer ? { ...t, renderer } : t,
        ),
      );
    },
    [],
  );

  const handleRemoteCwdChanged = useCallback(
    (uiId: string, remotePosixDir: string) => {
      setTabRemoteCwds((prev) =>
        prev[uiId] === remotePosixDir
          ? prev
          : { ...prev, [uiId]: remotePosixDir },
      );
    },
    [],
  );

  const handleRenameTab = useCallback((uiId: string, newTitle: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.uiId === uiId ? { ...t, title: newTitle } : t)),
    );
  }, []);

  const handleToggleSyncPolicy = useCallback(
    async (
      autoSyncEnabled: boolean,
      crlfGuardEnabled: boolean,
      syncDeletions: boolean,
    ) => {
      if (!selectedProfileId) return;
      try {
        const updated = await syncUpdatePolicy(
          selectedProfileId,
          autoSyncEnabled,
          crlfGuardEnabled,
          syncDeletions,
        );
        setSyncStatuses((prev) => ({ ...prev, [selectedProfileId]: updated }));
        await refreshProfiles(selectedProfileId);
      } catch (err) {
        setBannerError(formatError(err));
      }
    },
    [refreshProfiles, selectedProfileId],
  );

  const handleRunReconcile = useCallback(
    async (dryRun: boolean) => {
      if (!selectedProfileId) return;
      setReconcileBusy(true);
      setBannerError(null);
      try {
        const report = await reconcileWorkspace(selectedProfileId, dryRun);
        if (dryRun) {
          setReconcileReport(report);
        } else {
          setSyncRefreshTick((t) => t + 1);
        }
      } catch (err) {
        setBannerError(formatError(err));
      } finally {
        setReconcileBusy(false);
      }
    },
    [selectedProfileId],
  );

  const handleRetrySync = useCallback(async () => {
    if (!selectedProfileId) return;
    setBannerError(null);
    try {
      await syncRetry(selectedProfileId);
    } catch (err) {
      setBannerError(formatError(err));
    }
  }, [selectedProfileId]);

  const handleClearActivityLog = useCallback(async () => {
    if (!selectedProfileId) return;
    try {
      await syncClearActivityLog(selectedProfileId);
      setSyncLogsByProfile((prev) => ({ ...prev, [selectedProfileId]: [] }));
    } catch (err) {
      setBannerError(formatError(err));
    }
  }, [selectedProfileId]);

  const activeSyncStatus = selectedProfileId
    ? (syncStatuses[selectedProfileId] ?? null)
    : null;
  const activeSyncLog = selectedProfileId
    ? (syncLogsByProfile[selectedProfileId] ?? [])
    : [];

  const activeFollowedRemoteDir =
    followTerminalCwd && activeTabUiId
      ? (tabRemoteCwds[activeTabUiId] ?? null)
      : null;

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-zinc-100 overflow-hidden">
      {/* Compact Top Bar */}
      <TopBar
        profiles={profiles}
        selectedProfileId={selectedProfileId}
        onSelectProfile={setSelectedProfileId}
        activeStatus={activeStatus}
        storageInfo={storageInfo}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        onOpenNewTerminal={handleOpenNewTerminal}
        onOpenProfileModal={(createMode = false) => {
          setProfileModalCreateMode(createMode);
          setProfileModalOpen(true);
        }}
      />

      {/* Always-Visible Live Sync Control Bar */}
      <SyncControlBar
        profile={selectedProfile}
        isConnected={isSelectedConnected}
        syncStatus={activeSyncStatus}
        activityLog={activeSyncLog}
        reconcileBusy={reconcileBusy}
        reconcileReport={reconcileReport}
        onCloseReconcileReport={() => setReconcileReport(null)}
        onTogglePolicy={(auto, crlf, del) =>
          void handleToggleSyncPolicy(auto, crlf, del)
        }
        onRunReconcile={(dryRun) => void handleRunReconcile(dryRun)}
        onRetrySync={() => void handleRetrySync()}
        onClearActivityLog={() => void handleClearActivityLog()}
      />

      {/* Transient Error Banner */}
      {bannerError && (
        <div className="px-3 py-1.5 bg-rose-950/80 border-b border-rose-800/80 flex items-center justify-between gap-2 font-mono text-xs text-rose-200 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
            <span className="truncate">{bannerError}</span>
          </div>
          <button
            type="button"
            onClick={() => setBannerError(null)}
            className="p-0.5 rounded hover:bg-rose-900/60 text-rose-300"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Split Workbench */}
      <main className="flex-1 min-h-0 flex flex-col">
        {/* Upper Workspace Area: Dual-Pane Local <-> SFTP Explorer */}
        {!isDockMaximized && (
          <div className="flex-1 min-h-[160px] overflow-hidden">
            <DualPaneExplorer
              profile={selectedProfile}
              status={activeStatus}
              hasActiveTerminal={Boolean(activeReadyTerminalTab)}
              syncRefreshTick={syncRefreshTick}
              leftRatio={explorerLeftRatio}
              onLeftRatioChange={setExplorerLeftRatio}
              followedRemoteDir={activeFollowedRemoteDir}
              onConnect={handleConnect}
              onCreateProfile={() => {
                setProfileModalCreateMode(true);
                setProfileModalOpen(true);
              }}
              onSendCommandToTerminal={handleSendCommandToTerminal}
              onNotifyError={setBannerError}
            />
          </div>
        )}

        {/* Drag Splitter */}
        {!isDockMaximized && (
          <div
            role="separator"
            aria-orientation="horizontal"
            onPointerDown={startSplitterDrag}
            className="h-1.5 shrink-0 bg-zinc-900 border-y border-zinc-800 hover:bg-emerald-500/40 hover:border-emerald-500/60 cursor-row-resize transition-colors flex items-center justify-center"
          >
            <div className="w-10 h-0.5 bg-zinc-700 rounded-full" />
          </div>
        )}

        {/* Per-Profile Hardware & Build Macro Bar (Directly Above Terminal Dock) */}
        <MacroBar
          profile={selectedProfile}
          isConnected={isSelectedConnected}
          runningMacroId={runningMacroId}
          followTerminalCwd={followTerminalCwd}
          hasActiveTerminal={Boolean(activeReadyTerminalTab)}
          onToggleFollowTerminalCwd={setFollowTerminalCwd}
          onInjectOsc7Hook={handleInjectOsc7Hook}
          onTriggerMacro={(m) => void handleTriggerMacro(m)}
          onSaveMacros={handleSaveProfileMacros}
        />

        {/* Resizable Bottom Multi-Tab Terminal Dock */}
        <div
          style={isDockMaximized ? undefined : { height: `${dockHeight}px` }}
          className={
            isDockMaximized ? "flex-1 min-h-0" : "shrink-0 min-h-[160px]"
          }
        >
          <TerminalDock
            tabs={tabs}
            activeTabUiId={activeTabUiId}
            canOpenNewTab={isSelectedConnected}
            isMaximized={isDockMaximized}
            onToggleMaximize={() => setIsDockMaximized((v) => !v)}
            onSelectTab={setActiveTabUiId}
            onNewTab={handleOpenNewTerminal}
            onCloseTab={handleCloseTab}
            onRenameTab={handleRenameTab}
            onEnsureConnected={handleEnsureConnected}
            onPtyOpened={handlePtyOpened}
            onPtyOpenError={handlePtyOpenError}
            onDimensionsChange={handleDimensionsChange}
            onRendererChange={handleRendererChange}
            onRemoteCwdChanged={handleRemoteCwdChanged}
            onTriggerMacroIndex={handleTriggerMacroIndex}
          />
        </div>
      </main>

      {/* Profile & Known Hosts Manager Modal */}
      <ProfileManagerModal
        isOpen={profileModalOpen}
        startInCreateMode={profileModalCreateMode}
        profiles={profiles}
        activeProfileId={selectedProfileId}
        storageInfo={storageInfo}
        onClose={() => setProfileModalOpen(false)}
        onProfilesChanged={refreshProfiles}
      />

      {/* Interactive TOFU / Changed Host Key Verification Modal */}
      <HostKeyModal
        prompt={hostKeyQueue[0] ?? null}
        onRespond={handleRespondHostKey}
      />
    </div>
  );
};
