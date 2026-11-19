import React, { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { ChevronDown, ChevronUp, RotateCcw, Search, X } from "lucide-react";
import {
  formatError,
  parseOsc7RemotePath,
  ptyClose,
  ptyOpen,
  ptyResize,
  ptyWrite,
} from "../../lib/ipc";

interface TerminalPaneProps {
  uiId: string;
  profileId: string;
  isActive: boolean;
  initialCommand?: string;
  remoteExitedCode: number | null | undefined;
  isRemotelyClosed: boolean;
  isTransportDisconnected: boolean;
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
  onRequestNewTab: () => void;
  onRequestCloseTab: () => void;
  searchToggleSignal: number;
}

const textEncoder = new TextEncoder();

export const TerminalPane: React.FC<TerminalPaneProps> = ({
  uiId,
  profileId,
  isActive,
  initialCommand,
  remoteExitedCode,
  isRemotelyClosed,
  isTransportDisconnected,
  onEnsureConnected,
  onPtyOpened,
  onPtyOpenError,
  onDimensionsChange,
  onRendererChange,
  onRemoteCwdChanged,
  onTriggerMacroIndex,
  onRequestNewTab,
  onRequestCloseTab,
  searchToggleSignal,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const ptyTabIdRef = useRef<string | null>(null);
  const remotelyClosedRef = useRef<boolean>(false);
  const transportDisconnectedRef = useRef<boolean>(false);
  const reopeningRef = useRef<boolean>(false);
  const initialCmdSentRef = useRef<boolean>(false);
  const lastSentDimsRef = useRef<{ cols: number; rows: number }>({
    cols: 0,
    rows: 0,
  });

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [reopening, setReopening] = useState(false);

  const callbacksRef = useRef({
    onEnsureConnected,
    onPtyOpened,
    onPtyOpenError,
    onDimensionsChange,
    onRendererChange,
    onRemoteCwdChanged,
    onTriggerMacroIndex,
    onRequestNewTab,
    onRequestCloseTab,
    initialCommand,
  });
  callbacksRef.current = {
    onEnsureConnected,
    onPtyOpened,
    onPtyOpenError,
    onDimensionsChange,
    onRendererChange,
    onRemoteCwdChanged,
    onTriggerMacroIndex,
    onRequestNewTab,
    onRequestCloseTab,
    initialCommand,
  };

  const syncFitAndResize = useCallback(() => {
    const container = containerRef.current;
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!container || !term || !fitAddon) return;
    if (container.clientWidth < 16 || container.clientHeight < 16) return;

    try {
      fitAddon.fit();
    } catch {
      return;
    }

    const cols = term.cols;
    const rows = term.rows;
    if (cols <= 0 || rows <= 0) return;

    callbacksRef.current.onDimensionsChange(uiId, cols, rows);

    const prev = lastSentDimsRef.current;
    if (
      ptyTabIdRef.current &&
      !remotelyClosedRef.current &&
      !transportDisconnectedRef.current &&
      (prev.cols !== cols || prev.rows !== rows)
    ) {
      lastSentDimsRef.current = { cols, rows };
      void ptyResize(ptyTabIdRef.current, cols, rows).catch(() => {});
    }
  }, [uiId]);

  const handleReopenShell = useCallback(async () => {
    const term = termRef.current;
    if (!term || reopeningRef.current) return;
    reopeningRef.current = true;
    setReopening(true);

    try {
      const ok = await callbacksRef.current.onEnsureConnected(profileId);
      if (!ok) {
        reopeningRef.current = false;
        setReopening(false);
        return;
      }

      const cols = term.cols || 80;
      const rows = term.rows || 24;
      const newPtyId = await ptyOpen(profileId, cols, rows, (chunk) => {
        term.write(chunk);
      });

      ptyTabIdRef.current = newPtyId;
      transportDisconnectedRef.current = false;
      remotelyClosedRef.current = false;
      lastSentDimsRef.current = { cols, rows };

      term.writeln("\r\n\x1b[32m[Reopened multiplexed SSH shell]\x1b[0m");
      callbacksRef.current.onPtyOpened(uiId, newPtyId, cols, rows);
      syncFitAndResize();
      term.focus();
    } catch (err) {
      term.writeln(
        `\r\n\x1b[31m[Failed to reopen shell: ${formatError(err)}]\x1b[0m`,
      );
    } finally {
      reopeningRef.current = false;
      setReopening(false);
    }
  }, [profileId, syncFitAndResize, uiId]);

  // Mount isolated xterm instance + open multiplexed SSH PTY channel
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let resizeTimer: number | null = null;
    const pendingWrites: Uint8Array[] = [];

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 13,
      lineHeight: 1.2,
      fontFamily:
        '"Cascadia Mono", "JetBrains Mono", Consolas, ui-monospace, SFMono-Regular, monospace',
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: {
        background: "#020617",
        foreground: "#e4e4e7",
        cursor: "#10b981",
        cursorAccent: "#020617",
        selectionBackground: "rgba(16, 185, 129, 0.28)",
        black: "#18181b",
        red: "#f43f5e",
        green: "#10b981",
        yellow: "#f59e0b",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#e4e4e7",
        brightBlack: "#52525b",
        brightRed: "#fb7185",
        brightGreen: "#34d399",
        brightYellow: "#fbbf24",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#fafafa",
      },
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);

    // Detect OSC 7 (`\x1b]7;file://host/path\x07`) for Follow Terminal Directory
    const osc7Disposable = term.parser.registerOscHandler(7, (data: string) => {
      const parsedDir = parseOsc7RemotePath(data);
      if (parsedDir && !disposed) {
        callbacksRef.current.onRemoteCwdChanged(uiId, parsedDir);
      }
      return true;
    });

    term.open(container);
    termRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        try {
          webglAddon?.dispose();
        } catch {
          // Ignore
        }
        webglAddon = null;
        if (!disposed) {
          callbacksRef.current.onRendererChange(uiId, "canvas");
        }
      });
      term.loadAddon(webglAddon);
      callbacksRef.current.onRendererChange(uiId, "webgl");
    } catch {
      webglAddon = null;
      callbacksRef.current.onRendererChange(uiId, "canvas");
    }

    term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.type !== "keydown") return true;

      // Press Enter to reopen a disconnected or exited shell in place
      if (
        ev.key === "Enter" &&
        !ev.ctrlKey &&
        !ev.altKey &&
        (transportDisconnectedRef.current || remotelyClosedRef.current)
      ) {
        ev.preventDefault();
        void handleReopenShell();
        return false;
      }

      // Alt+1 through Alt+5 Macro shortcuts
      if (
        ev.altKey &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        /^Digit[1-5]$/.test(ev.code)
      ) {
        ev.preventDefault();
        const macroIdx = Number(ev.code.slice("Digit".length)) - 1;
        callbacksRef.current.onTriggerMacroIndex(macroIdx);
        return false;
      }

      if (ev.ctrlKey && ev.shiftKey) {
        switch (ev.code) {
          case "KeyC": {
            ev.preventDefault();
            const selection = term.getSelection();
            if (selection) {
              void navigator.clipboard.writeText(selection).catch(() => {});
            }
            return false;
          }
          case "KeyV": {
            ev.preventDefault();
            void navigator.clipboard
              .readText()
              .then((text) => {
                if (text && !disposed) {
                  term.paste(text);
                }
              })
              .catch(() => {});
            return false;
          }
          case "KeyF": {
            ev.preventDefault();
            setSearchOpen(true);
            requestAnimationFrame(() => searchInputRef.current?.focus());
            return false;
          }
          case "KeyT": {
            ev.preventDefault();
            callbacksRef.current.onRequestNewTab();
            return false;
          }
          case "KeyW": {
            ev.preventDefault();
            callbacksRef.current.onRequestCloseTab();
            return false;
          }
          default:
            break;
        }
      }
      return true;
    });

    const enqueueOrSend = (bytes: Uint8Array) => {
      if (
        disposed ||
        remotelyClosedRef.current ||
        transportDisconnectedRef.current ||
        bytes.length === 0
      ) {
        return;
      }
      const activePtyId = ptyTabIdRef.current;
      if (!activePtyId) {
        pendingWrites.push(bytes);
      } else {
        void ptyWrite(activePtyId, bytes).catch(() => {});
      }
    };

    const dataDisposable = term.onData((data) => {
      enqueueOrSend(textEncoder.encode(data));
    });

    const binaryDisposable = term.onBinary((bin) => {
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i) & 0xff;
      }
      enqueueOrSend(bytes);
    });

    try {
      if (container.clientWidth >= 16 && container.clientHeight >= 16) {
        fitAddon.fit();
      }
    } catch {
      // Fallback 80x24
    }

    const initialCols = term.cols || 80;
    const initialRows = term.rows || 24;
    lastSentDimsRef.current = { cols: initialCols, rows: initialRows };
    callbacksRef.current.onDimensionsChange(uiId, initialCols, initialRows);

    void ptyOpen(profileId, initialCols, initialRows, (chunk) => {
      if (!disposed) {
        term.write(chunk);
      }
    })
      .then((resolvedTabId) => {
        if (disposed) {
          void ptyClose(resolvedTabId).catch(() => {});
          return;
        }
        ptyTabIdRef.current = resolvedTabId;
        callbacksRef.current.onPtyOpened(
          uiId,
          resolvedTabId,
          term.cols,
          term.rows,
        );

        while (pendingWrites.length > 0) {
          const next = pendingWrites.shift();
          if (next) {
            void ptyWrite(resolvedTabId, next).catch(() => {});
          }
        }

        const initCmd = callbacksRef.current.initialCommand;
        if (initCmd && !initialCmdSentRef.current) {
          initialCmdSentRef.current = true;
          void ptyWrite(resolvedTabId, textEncoder.encode(initCmd)).catch(
            () => {},
          );
        }

        syncFitAndResize();
        term.focus();
      })
      .catch((err) => {
        if (disposed) return;
        const msg = formatError(err);
        term.writeln(`\r\n\x1b[31m[LabBridge PTY Error] ${msg}\x1b[0m`);
        callbacksRef.current.onPtyOpenError(uiId, msg);
      });

    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(() => {
        if (!disposed) {
          syncFitAndResize();
        }
      }, 60);
    });
    observer.observe(container);

    return () => {
      disposed = true;
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }
      observer.disconnect();
      osc7Disposable.dispose();
      dataDisposable.dispose();
      binaryDisposable.dispose();

      const tabToClose = ptyTabIdRef.current;
      ptyTabIdRef.current = null;
      if (
        tabToClose &&
        !remotelyClosedRef.current &&
        !transportDisconnectedRef.current
      ) {
        void ptyClose(tabToClose).catch(() => {});
      }

      try {
        webglAddon?.dispose();
      } catch {
        // Ignore
      }
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [handleReopenShell, profileId, syncFitAndResize, uiId]);

  useEffect(() => {
    if (!isActive) return;
    const raf = requestAnimationFrame(() => {
      syncFitAndResize();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive, syncFitAndResize]);

  // Display subtle banner when VPN blips / transport disconnects unexpectedly
  useEffect(() => {
    if (isTransportDisconnected && !transportDisconnectedRef.current) {
      transportDisconnectedRef.current = true;
      ptyTabIdRef.current = null;
      termRef.current?.writeln(
        "\r\n\x1b[33m[Disconnected - Press Enter to Reopen Shell]\x1b[0m",
      );
    }
  }, [isTransportDisconnected]);

  useEffect(() => {
    if (
      isRemotelyClosed &&
      !remotelyClosedRef.current &&
      !transportDisconnectedRef.current
    ) {
      remotelyClosedRef.current = true;
      ptyTabIdRef.current = null;
      const codeInfo =
        remoteExitedCode !== null && remoteExitedCode !== undefined
          ? ` (exit code ${remoteExitedCode})`
          : "";
      termRef.current?.writeln(
        `\r\n\x1b[90m[Remote shell session ended${codeInfo} — Press Enter to Reopen Shell]\x1b[0m`,
      );
    }
  }, [isRemotelyClosed, remoteExitedCode]);

  useEffect(() => {
    if (searchToggleSignal === 0 || !isActive) return;
    setSearchOpen((prev) => {
      const next = !prev;
      if (next) {
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else {
        termRef.current?.focus();
      }
      return next;
    });
  }, [searchToggleSignal, isActive]);

  const runSearch = (direction: "next" | "prev", queryOverride?: string) => {
    const q = queryOverride ?? searchQuery;
    if (!q || !searchAddonRef.current) return;
    const opts = { caseSensitive, regex: useRegex };
    if (direction === "next") {
      searchAddonRef.current.findNext(q, opts);
    } else {
      searchAddonRef.current.findPrevious(q, opts);
    }
  };

  const closeSearch = () => {
    setSearchOpen(false);
    termRef.current?.focus();
  };

  return (
    <div
      className={`relative h-full w-full bg-slate-950 ${
        isActive ? "block" : "hidden"
      }`}
    >
      {/* Subtle Reopen Banner Overlay when Disconnected */}
      {(isTransportDisconnected || isRemotelyClosed) && (
        <button
          type="button"
          disabled={reopening}
          onClick={() => void handleReopenShell()}
          className="absolute bottom-3 right-4 z-20 inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-zinc-900/95 border border-amber-700/80 hover:border-amber-500 text-amber-200 font-mono text-[11px] shadow-lg transition-colors"
        >
          <RotateCcw
            className={`w-3 h-3 ${reopening ? "animate-spin" : ""}`}
          />
          <span>
            {reopening
              ? "Reopening shell..."
              : "[Disconnected - Press Enter to Reopen Shell]"}
          </span>
        </button>
      )}

      {/* Inline Search Bar */}
      {searchOpen && (
        <div className="absolute top-2 right-4 z-20 flex items-center gap-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 shadow-xl font-mono text-xs">
          <Search className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            placeholder="Find in buffer..."
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value) {
                runSearch("next", e.target.value);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runSearch(e.shiftKey ? "prev" : "next");
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
            className="w-44 bg-slate-950 border border-zinc-800 focus:border-emerald-500/70 focus:outline-none rounded px-2 py-0.5 text-xs text-zinc-100"
          />
          <button
            type="button"
            onClick={() => setCaseSensitive((v) => !v)}
            title="Match Case"
            className={`px-1.5 py-0.5 rounded border text-[10px] ${
              caseSensitive
                ? "border-emerald-600 bg-emerald-950/60 text-emerald-300"
                : "border-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Aa
          </button>
          <button
            type="button"
            onClick={() => setUseRegex((v) => !v)}
            title="Regular Expression"
            className={`px-1.5 py-0.5 rounded border text-[10px] ${
              useRegex
                ? "border-emerald-600 bg-emerald-950/60 text-emerald-300"
                : "border-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            .*
          </button>
          <button
            type="button"
            onClick={() => runSearch("prev")}
            title="Previous Match (Shift+Enter)"
            className="p-0.5 rounded hover:bg-zinc-800 text-zinc-300"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => runSearch("next")}
            title="Next Match (Enter)"
            className="p-0.5 rounded hover:bg-zinc-800 text-zinc-300"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={closeSearch}
            title="Close Search (Esc)"
            className="p-0.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div ref={containerRef} className="h-full w-full overflow-hidden" />
    </div>
  );
};
