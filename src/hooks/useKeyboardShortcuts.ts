import { useEffect } from "react";

export interface KeyboardShortcutHandlers {
  /** Alt+1 through Alt+5 — trigger profile macros by index */
  onTriggerMacroIndex: (index: number) => void;
  /** Ctrl+, — open profile settings modal */
  onOpenSettings: () => void;
  /** Ctrl+J — toggle terminal dock maximize */
  onToggleDockMaximize: () => void;
  /** Ctrl+Shift+T — open new terminal tab */
  onOpenNewTerminal: () => void;
  /** Ctrl+Shift+W — close active terminal tab */
  onCloseActiveTab: () => void;
  /** Whether a terminal tab is currently active (enables Ctrl+Shift+W) */
  hasActiveTab: boolean;
}

/**
 * Global workbench keyboard shortcuts.
 *
 * Registers a single `keydown` listener on `window` and dispatches to the
 * provided handlers. Extracted from `App.tsx` to keep the component focused
 * on state orchestration.
 *
 * Shortcuts handled:
 * - `Alt+1..Alt+5`       → trigger macro by index
 * - `Ctrl+,`             → open profile/settings modal
 * - `Ctrl+J`             → maximize / restore terminal dock
 * - `Ctrl+Shift+T`       → open new terminal tab
 * - `Ctrl+Shift+W`       → close active terminal tab
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers): void {
  const {
    onTriggerMacroIndex,
    onOpenSettings,
    onToggleDockMaximize,
    onOpenNewTerminal,
    onCloseActiveTab,
    hasActiveTab,
  } = handlers;

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      // Alt+1 through Alt+5 — hardware/build macros
      if (
        ev.altKey &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        /^Digit[1-5]$/.test(ev.code)
      ) {
        ev.preventDefault();
        const idx = Number(ev.code.slice("Digit".length)) - 1;
        onTriggerMacroIndex(idx);
        return;
      }

      if (ev.ctrlKey && !ev.shiftKey && ev.key === ",") {
        ev.preventDefault();
        onOpenSettings();
      } else if (ev.ctrlKey && !ev.shiftKey && ev.code === "KeyJ") {
        ev.preventDefault();
        onToggleDockMaximize();
      } else if (ev.ctrlKey && ev.shiftKey && ev.code === "KeyT") {
        ev.preventDefault();
        onOpenNewTerminal();
      } else if (ev.ctrlKey && ev.shiftKey && ev.code === "KeyW") {
        if (hasActiveTab) {
          ev.preventDefault();
          onCloseActiveTab();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    onTriggerMacroIndex,
    onOpenSettings,
    onToggleDockMaximize,
    onOpenNewTerminal,
    onCloseActiveTab,
    hasActiveTab,
  ]);
}
