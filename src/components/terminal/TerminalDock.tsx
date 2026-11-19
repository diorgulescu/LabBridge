import React, { useState } from "react";
import {
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Search,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { TerminalPane } from "./TerminalPane";
import type { TerminalTabModel } from "../../types/labbridge";

interface TerminalDockProps {
  tabs: TerminalTabModel[];
  activeTabUiId: string | null;
  canOpenNewTab: boolean;
  isMaximized: boolean;
  onToggleMaximize: () => void;
  onSelectTab: (uiId: string) => void;
  onNewTab: () => void;
  onCloseTab: (uiId: string) => void;
  onRenameTab: (uiId: string, newTitle: string) => void;
  onEnsureConnected: (profileId: string) => Promise<boolean>;
  onPtyOpened: (
    uiId: string,
    ptyTabId: string,
    cols: number,
    rows: number,
  ) => void;
  onPtyOpenError: (uiId: string, errorMessage: string) => void;
  onDimensionsChange: (uiId: string, cols: number, rows: number) => void;
  onRendererChange: (uiId: string, renderer: "webgl" | "canvas") => void;
  onRemoteCwdChanged: (uiId: string, remotePosixDir: string) => void;
  onTriggerMacroIndex: (index: number) => void;
}

export const TerminalDock: React.FC<TerminalDockProps> = ({
  tabs,
  activeTabUiId,
  canOpenNewTab,
  isMaximized,
  onToggleMaximize,
  onSelectTab,
  onNewTab,
  onCloseTab,
  onRenameTab,
  onEnsureConnected,
  onPtyOpened,
  onPtyOpenError,
  onDimensionsChange,
  onRendererChange,
  onRemoteCwdChanged,
  onTriggerMacroIndex,
}) => {
  const [editingUiId, setEditingUiId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [searchToggleSignal, setSearchToggleSignal] = useState(0);

  const activeTab = tabs.find((t) => t.uiId === activeTabUiId) ?? null;

  const startRename = (tab: TerminalTabModel) => {
    setEditingUiId(tab.uiId);
    setEditingTitle(tab.title);
  };

  const commitRename = (uiId: string) => {
    const trimmed = editingTitle.trim();
    if (trimmed.length > 0) {
      onRenameTab(uiId, trimmed);
    }
    setEditingUiId(null);
  };

  return (
    <section className="h-full w-full flex flex-col bg-slate-950 min-h-0">
      {/* Multi-Tab Header Bar */}
      <div className="h-9 shrink-0 bg-zinc-900 border-b border-zinc-800 px-2 flex items-center justify-between gap-2">
        {/* Scrollable Tab Strip */}
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto py-1">
          <div className="flex items-center gap-1.5 px-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500 shrink-0">
            <TerminalIcon className="w-3.5 h-3.5 text-emerald-500" />
            <span>PTY</span>
          </div>

          {tabs.map((tab) => {
            const selected = tab.uiId === activeTabUiId;
            const isEditing = editingUiId === tab.uiId;

            const statusDotClass =
              tab.status === "ready"
                ? "bg-emerald-400"
                : tab.status === "opening"
                  ? "bg-amber-400 animate-pulse"
                  : tab.status === "disconnected"
                    ? "bg-amber-500"
                    : tab.status === "error"
                      ? "bg-rose-500"
                      : "bg-zinc-600";

            return (
              <div
                key={tab.uiId}
                onClick={() => onSelectTab(tab.uiId)}
                onDoubleClick={() => startRename(tab)}
                className={`group inline-flex items-center gap-1.5 h-7 px-2.5 rounded border cursor-pointer shrink-0 font-mono text-xs transition-colors ${
                  selected
                    ? "bg-slate-950 border-zinc-700 text-zinc-100"
                    : "bg-zinc-900/60 border-zinc-800/80 hover:bg-zinc-800/60 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${statusDotClass}`} />

                {isEditing ? (
                  <input
                    autoFocus
                    type="text"
                    value={editingTitle}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={() => commitRename(tab.uiId)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        commitRename(tab.uiId);
                      } else if (e.key === "Escape") {
                        setEditingUiId(null);
                      }
                    }}
                    className="w-28 bg-zinc-900 border border-emerald-500/80 rounded px-1 py-0 text-xs text-zinc-100 focus:outline-none"
                  />
                ) : (
                  <span className="max-w-[175px] truncate select-none">
                    {tab.title}
                  </span>
                )}

                {!isEditing && (
                  <button
                    type="button"
                    title="Rename Tab (Double-click)"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(tab);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-opacity"
                  >
                    <Pencil className="w-2.5 h-2.5" />
                  </button>
                )}

                <button
                  type="button"
                  title="Close Tab (Ctrl+Shift+W)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.uiId);
                  }}
                  className="p-0.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-rose-300"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            disabled={!canOpenNewTab}
            onClick={onNewTab}
            title={
              canOpenNewTab
                ? "Open New Multiplexed PTY Shell (Ctrl+Shift+T)"
                : "Connect to a profile first to open a shell"
            }
            className="inline-flex items-center gap-1 h-7 px-2 rounded border border-zinc-800 hover:border-zinc-700 bg-slate-950 hover:bg-zinc-800/70 disabled:opacity-35 disabled:pointer-events-none font-mono text-[11px] text-zinc-300 shrink-0"
          >
            <Plus className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden sm:inline">Shell</span>
          </button>
        </div>

        {/* Right Terminal Controls & Telemetry */}
        <div className="flex items-center gap-2 shrink-0 font-mono text-[10px] text-zinc-400">
          {activeTab && (
            <>
              <span
                title="Terminal grid dimensions (cols × rows)"
                className="hidden md:inline px-1.5 py-0.5 rounded bg-slate-950 border border-zinc-800 text-zinc-400"
              >
                {activeTab.cols}×{activeTab.rows}
              </span>
              <span
                title="xterm.js rendering pipeline"
                className={`hidden sm:inline px-1.5 py-0.5 rounded border ${
                  activeTab.renderer === "webgl"
                    ? "bg-emerald-950/30 border-emerald-800/60 text-emerald-300"
                    : "bg-zinc-950 border-zinc-800 text-zinc-400"
                }`}
              >
                {activeTab.renderer.toUpperCase()}
              </span>
              <button
                type="button"
                onClick={() => setSearchToggleSignal((n) => n + 1)}
                title="Find in Terminal (Ctrl+Shift+F)"
                className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
              >
                <Search className="w-3.5 h-3.5" />
              </button>
            </>
          )}

          <button
            type="button"
            onClick={onToggleMaximize}
            title={
              isMaximized
                ? "Restore Dock Height (Ctrl+J)"
                : "Maximize Terminal Dock (Ctrl+J)"
            }
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
          >
            {isMaximized ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Terminal Viewport Area */}
      <div className="flex-1 min-h-0 relative bg-slate-950">
        {tabs.length === 0 ? (
          <div className="h-full w-full flex flex-col items-center justify-center gap-2 px-4 text-center font-mono">
            <div className="text-xs text-zinc-400">
              {canOpenNewTab
                ? "Multiplexed SSH2 transport ready."
                : "No active SSH terminal channels."}
            </div>
            {canOpenNewTab ? (
              <button
                type="button"
                onClick={onNewTab}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-emerald-700/80 bg-emerald-950/60 hover:bg-emerald-900/60 text-emerald-200 text-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Open Terminal Tab (Ctrl+Shift+T)</span>
              </button>
            ) : (
              <div className="text-[11px] text-zinc-600">
                Select a profile in the top bar and click{" "}
                <span className="text-zinc-400">Connect</span> to spawn{" "}
                <code>xterm-256color</code> shells.
              </div>
            )}
          </div>
        ) : (
          tabs.map((tab) => (
            <TerminalPane
              key={tab.uiId}
              uiId={tab.uiId}
              profileId={tab.profileId}
              isActive={tab.uiId === activeTabUiId}
              initialCommand={tab.initialCommand}
              remoteExitedCode={tab.exitCode}
              isRemotelyClosed={tab.status === "exited"}
              isTransportDisconnected={tab.status === "disconnected"}
              onEnsureConnected={onEnsureConnected}
              onPtyOpened={onPtyOpened}
              onPtyOpenError={onPtyOpenError}
              onDimensionsChange={onDimensionsChange}
              onRendererChange={onRendererChange}
              onRemoteCwdChanged={onRemoteCwdChanged}
              onTriggerMacroIndex={onTriggerMacroIndex}
              onRequestNewTab={onNewTab}
              onRequestCloseTab={() => onCloseTab(tab.uiId)}
              searchToggleSignal={searchToggleSignal}
            />
          ))
        )}
      </div>
    </section>
  );
};
