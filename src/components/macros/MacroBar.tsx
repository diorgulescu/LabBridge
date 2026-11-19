import React, { useState } from "react";
import {
  Crosshair,
  ExternalLink,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Zap,
} from "lucide-react";
import {
  DEFAULT_CLIENT_MACROS,
  MacroEditorModal,
} from "./MacroEditorModal";
import type {
  MacroAccent,
  ProfileMacro,
  WorkspaceProfile,
} from "../../types/labbridge";

interface MacroBarProps {
  profile: WorkspaceProfile | null;
  isConnected: boolean;
  runningMacroId: string | null;
  followTerminalCwd: boolean;
  hasActiveTerminal: boolean;
  onToggleFollowTerminalCwd: (next: boolean) => void;
  onInjectOsc7Hook: () => void;
  onTriggerMacro: (macro: ProfileMacro) => void;
  onSaveMacros: (macros: ProfileMacro[]) => Promise<void>;
}

function getAccentButtonClasses(accent: MacroAccent): string {
  switch (accent) {
    case "emerald":
      return "border-emerald-800/80 bg-emerald-950/35 hover:bg-emerald-900/45 text-emerald-200";
    case "cyan":
      return "border-cyan-800/80 bg-cyan-950/35 hover:bg-cyan-900/45 text-cyan-200";
    case "amber":
      return "border-amber-800/80 bg-amber-950/35 hover:bg-amber-900/45 text-amber-200";
    case "indigo":
      return "border-indigo-800/80 bg-indigo-950/35 hover:bg-indigo-900/45 text-indigo-200";
    case "rose":
      return "border-rose-800/80 bg-rose-950/35 hover:bg-rose-900/45 text-rose-200";
    case "zinc":
    default:
      return "border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200";
  }
}

export const MacroBar: React.FC<MacroBarProps> = ({
  profile,
  isConnected,
  runningMacroId,
  followTerminalCwd,
  hasActiveTerminal,
  onToggleFollowTerminalCwd,
  onInjectOsc7Hook,
  onTriggerMacro,
  onSaveMacros,
}) => {
  const [editorOpen, setEditorOpen] = useState(false);

  const macros =
    profile?.macros && profile.macros.length > 0
      ? profile.macros
      : DEFAULT_CLIENT_MACROS;

  return (
    <>
      <div className="h-8 shrink-0 bg-zinc-950 border-t border-zinc-800 px-2.5 flex items-center justify-between gap-2 font-mono text-[11px] select-none">
        {/* Left: Per-Profile Hardware & Build Macro Buttons */}
        <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto py-0.5">
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500 shrink-0 mr-0.5">
            <Zap className="w-3 h-3 text-amber-400" />
            <span className="hidden sm:inline">MACROS</span>
          </span>

          {macros.map((m, idx) => {
            const isFlushing = runningMacroId === m.id;
            const shortcut = idx < 5 ? `Alt+${idx + 1}` : null;

            return (
              <button
                key={m.id}
                type="button"
                disabled={!profile || !isConnected || Boolean(runningMacroId)}
                onClick={() => onTriggerMacro(m)}
                title={`${m.command}${
                  m.flush_sync_before_run
                    ? " (Flushes pending sync before running)"
                    : ""
                }${
                  m.target_mode === "dedicated_tab"
                    ? " -> Dedicated Output Tab"
                    : " -> Active Terminal"
                }`}
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border shrink-0 transition-colors disabled:opacity-35 disabled:pointer-events-none ${getAccentButtonClasses(
                  m.accent,
                )}`}
              >
                {isFlushing ? (
                  <RefreshCw className="w-3 h-3 animate-spin shrink-0" />
                ) : m.target_mode === "dedicated_tab" ? (
                  <ExternalLink className="w-3 h-3 opacity-75 shrink-0" />
                ) : null}

                <span className="truncate max-w-[160px]">{m.label}</span>

                {shortcut && (
                  <span className="px-1 rounded bg-black/40 border border-white/10 text-[9px] opacity-80">
                    {shortcut}
                  </span>
                )}
              </button>
            );
          })}

          {profile && (
            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              title="Customize Profile Macros"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-zinc-800 hover:border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200 text-[10px] shrink-0"
            >
              <SlidersHorizontal className="w-3 h-3" />
              <span className="hidden md:inline">Edit</span>
            </button>
          )}
        </div>

        {/* Right: Follow Terminal Directory (OSC 7) & Prompt Hook Helper */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => onToggleFollowTerminalCwd(!followTerminalCwd)}
            title="Automatically sync the Right SFTP Explorer pane to the active SSH terminal's working directory (via OSC 7)"
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] transition-colors ${
              followTerminalCwd
                ? "border-emerald-700/80 bg-emerald-950/45 text-emerald-300"
                : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Crosshair className="w-3 h-3" />
            <span>Follow Terminal: {followTerminalCwd ? "ON" : "OFF"}</span>
          </button>

          <button
            type="button"
            disabled={!isConnected || !hasActiveTerminal}
            onClick={onInjectOsc7Hook}
            title="Inject Bash/Zsh OSC 7 PROMPT_COMMAND hook into the active shell so `cd` updates the SFTP Explorer automatically"
            className="hidden lg:inline-flex items-center gap-1 px-2 py-0.5 rounded border border-zinc-800 hover:border-cyan-700/70 bg-zinc-900 hover:bg-cyan-950/30 disabled:opacity-35 disabled:pointer-events-none text-[10px] text-cyan-300"
          >
            <Sparkles className="w-3 h-3" />
            <span>Inject Prompt Hook</span>
          </button>
        </div>
      </div>

      {profile && (
        <MacroEditorModal
          isOpen={editorOpen}
          profileName={profile.name}
          macros={macros}
          onClose={() => setEditorOpen(false)}
          onSave={onSaveMacros}
        />
      )}
    </>
  );
};
