import React from "react";
import {
  Activity,
  ChevronDown,
  HardDrive,
  Plug,
  Plus,
  PowerOff,
  Settings,
  TerminalSquare,
} from "lucide-react";
import type {
  ConnectionStatusPayload,
  StorageInfo,
  WorkspaceProfile,
} from "../types/labbridge";

interface TopBarProps {
  profiles: WorkspaceProfile[];
  selectedProfileId: string | null;
  onSelectProfile: (profileId: string) => void;
  activeStatus: ConnectionStatusPayload | null;
  storageInfo: StorageInfo | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenNewTerminal: () => void;
  onOpenProfileModal: (initialCreate?: boolean) => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  profiles,
  selectedProfileId,
  onSelectProfile,
  activeStatus,
  storageInfo,
  onConnect,
  onDisconnect,
  onOpenNewTerminal,
  onOpenProfileModal,
}) => {
  const stateTag = activeStatus?.connection_state.state ?? "Disconnected";
  const rttMs =
    activeStatus?.connection_state.state === "Connected"
      ? activeStatus.connection_state.rtt_ms
      : null;

  const isConnected = stateTag === "Connected";
  const isBusy = stateTag === "Connecting" || stateTag === "Reconnecting";

  const selectedProfile =
    profiles.find((p) => p.id === selectedProfileId) ?? null;

  const getLedClasses = () => {
    switch (stateTag) {
      case "Connected":
        if (rttMs !== null && rttMs > 180) {
          return "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.7)]";
        }
        return "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.75)]";
      case "Connecting":
      case "Reconnecting":
        return "bg-amber-400 animate-pulse shadow-[0_0_6px_rgba(251,191,36,0.7)]";
      default:
        return "bg-zinc-600";
    }
  };

  const getStatusLabel = () => {
    switch (stateTag) {
      case "Connected":
        return `CONNECTED · ${rttMs ?? 0}ms`;
      case "Connecting":
        return "CONNECTING...";
      case "Reconnecting":
        return `RECONNECTING${
          activeStatus?.reconnect_attempt
            ? ` #${activeStatus.reconnect_attempt}`
            : ""
        }`;
      default:
        return "DISCONNECTED";
    }
  };

  return (
    <header className="h-11 shrink-0 bg-zinc-900 border-b border-zinc-800 px-3 flex items-center justify-between gap-3 text-xs">
      {/* Left: Brand & Mode */}
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="flex items-center gap-1.5 font-mono font-semibold tracking-wider text-zinc-100">
          <span className="inline-block w-2 h-2 bg-emerald-500 rounded-[1px]" />
          <span>LABBRIDGE</span>
          <span className="text-[10px] text-zinc-500 font-normal">v0.1</span>
        </div>

        {storageInfo && (
          <span
            title={`Storage root: ${storageInfo.data_dir}`}
            className={`hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[10px] ${
              storageInfo.is_portable
                ? "border-cyan-800/70 bg-cyan-950/40 text-cyan-300"
                : "border-zinc-800 bg-zinc-950 text-zinc-400"
            }`}
          >
            <HardDrive className="w-2.5 h-2.5" />
            {storageInfo.is_portable ? "PORTABLE" : "APPDATA"}
          </span>
        )}

        <div className="h-4 w-px bg-zinc-800 mx-0.5" />

        {/* Profile Selector */}
        <div className="flex items-center gap-1.5">
          <div className="relative">
            <select
              aria-label="Workspace Profile"
              value={selectedProfileId ?? ""}
              onChange={(e) => onSelectProfile(e.target.value)}
              disabled={profiles.length === 0}
              className="appearance-none bg-slate-950 border border-zinc-800 hover:border-zinc-700 focus:border-emerald-500/70 focus:outline-none rounded px-2.5 pr-7 py-1 font-mono text-xs text-zinc-200 min-w-[220px] max-w-[320px] truncate disabled:text-zinc-500"
            >
              {profiles.length === 0 ? (
                <option value="">No profiles configured</option>
              ) : (
                profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.username}@{p.host}:{p.port}
                    {p.proxy_jump ? ` via ${p.proxy_jump.host}` : ""})
                  </option>
                ))
              )}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500 pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" />
          </div>

          <button
            type="button"
            onClick={() => onOpenProfileModal(true)}
            title="New Workspace Profile"
            className="p-1.5 rounded bg-slate-950 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/70 text-zinc-300 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Connect / Disconnect Trigger */}
        {isConnected || isBusy ? (
          <button
            type="button"
            onClick={onDisconnect}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-rose-800/80 bg-rose-950/50 hover:bg-rose-900/50 text-rose-200 font-mono text-xs transition-colors"
          >
            <PowerOff className="w-3.5 h-3.5" />
            <span>{isBusy ? "Abort" : "Disconnect"}</span>
          </button>
        ) : (
          <button
            type="button"
            disabled={!selectedProfile}
            onClick={onConnect}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-emerald-700/80 bg-emerald-950/60 hover:bg-emerald-900/60 disabled:opacity-40 disabled:pointer-events-none text-emerald-200 font-mono text-xs transition-colors"
          >
            <Plug className="w-3.5 h-3.5" />
            <span>Connect</span>
          </button>
        )}
      </div>

      {/* Right: Telemetry Badge & Triggers */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Connection & RTT LED Badge */}
        <div
          title={activeStatus?.message ?? getStatusLabel()}
          className="inline-flex items-center gap-2 px-2.5 py-1 rounded bg-slate-950 border border-zinc-800 font-mono text-[11px]"
        >
          <span className={`w-2 h-2 rounded-full ${getLedClasses()}`} />
          <span
            className={
              isConnected
                ? "text-emerald-300"
                : isBusy
                  ? "text-amber-300"
                  : "text-zinc-400"
            }
          >
            {getStatusLabel()}
          </span>
          {isConnected && (
            <Activity className="w-3 h-3 text-zinc-500 hidden md:inline" />
          )}
        </div>

        <button
          type="button"
          disabled={!isConnected}
          onClick={onOpenNewTerminal}
          title="New Multiplexed PTY Tab (Ctrl+Shift+T)"
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-slate-950 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/60 disabled:opacity-40 disabled:pointer-events-none text-zinc-200 font-mono text-xs transition-colors"
        >
          <TerminalSquare className="w-3.5 h-3.5 text-emerald-400" />
          <span className="hidden lg:inline">New Shell</span>
        </button>

        <button
          type="button"
          onClick={() => onOpenProfileModal(false)}
          title="Profiles, Keyring & Known Hosts Settings (Ctrl+,)"
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-slate-950 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/60 text-zinc-300 font-mono text-xs transition-colors"
        >
          <Settings className="w-3.5 h-3.5" />
          <span className="hidden xl:inline">Settings</span>
        </button>
      </div>
    </header>
  );
};
