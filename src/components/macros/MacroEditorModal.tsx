import React, { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Zap,
  X,
} from "lucide-react";
import type {
  MacroAccent,
  MacroTargetMode,
  ProfileMacro,
} from "../../types/labbridge";

export const DEFAULT_CLIENT_MACROS: ProfileMacro[] = [
  {
    id: "macro-build",
    label: "Build (make -j)",
    command: "make -j$(nproc)",
    accent: "emerald",
    target_mode: "active_terminal",
    flush_sync_before_run: true,
  },
  {
    id: "macro-ctest",
    label: "Run CTest",
    command: "ctest --output-on-failure",
    accent: "cyan",
    target_mode: "dedicated_tab",
    flush_sync_before_run: true,
  },
  {
    id: "macro-flash",
    label: "Flash Target",
    command: "./scripts/flash.sh",
    accent: "amber",
    target_mode: "dedicated_tab",
    flush_sync_before_run: true,
  },
  {
    id: "macro-dmesg",
    label: "Serial / dmesg",
    command: "sudo dmesg -wH",
    accent: "indigo",
    target_mode: "dedicated_tab",
    flush_sync_before_run: false,
  },
  {
    id: "macro-clean",
    label: "Clean",
    command: "make clean",
    accent: "rose",
    target_mode: "active_terminal",
    flush_sync_before_run: false,
  },
];

interface MacroEditorModalProps {
  isOpen: boolean;
  profileName: string;
  macros: ProfileMacro[];
  onClose: () => void;
  onSave: (macros: ProfileMacro[]) => Promise<void>;
}

const ACCENT_OPTIONS: { value: MacroAccent; label: string }[] = [
  { value: "emerald", label: "Emerald" },
  { value: "cyan", label: "Cyan" },
  { value: "amber", label: "Amber" },
  { value: "indigo", label: "Indigo" },
  { value: "rose", label: "Rose" },
  { value: "zinc", label: "Slate" },
];

export const MacroEditorModal: React.FC<MacroEditorModalProps> = ({
  isOpen,
  profileName,
  macros,
  onClose,
  onSave,
}) => {
  const [drafts, setDrafts] = useState<ProfileMacro[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setDrafts(
      macros.length > 0
        ? structuredClone(macros)
        : structuredClone(DEFAULT_CLIENT_MACROS),
    );

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, macros, onClose]);

  if (!isOpen) return null;

  const addMacro = () => {
    setDrafts((prev) => [
      ...prev,
      {
        id: `macro-${Date.now()}-${prev.length + 1}`,
        label: "Custom Task",
        command: "echo 'ready'",
        accent: "emerald",
        target_mode: "active_terminal",
        flush_sync_before_run: true,
      },
    ]);
  };

  const updateItem = (idx: number, patch: Partial<ProfileMacro>) => {
    setDrafts((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, ...patch } : item)),
    );
  };

  const moveItem = (idx: number, dir: -1 | 1) => {
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= drafts.length) return;
    setDrafts((prev) => {
      const copy = [...prev];
      const [picked] = copy.splice(idx, 1);
      copy.splice(nextIdx, 0, picked);
      return copy;
    });
  };

  const removeItem = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(drafts);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-[1px] flex items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        className="w-full max-w-4xl max-h-[84vh] bg-zinc-900 border border-zinc-800 rounded shadow-2xl flex flex-col overflow-hidden font-mono text-xs"
      >
        {/* Header */}
        <div className="h-11 px-4 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <span className="font-semibold uppercase tracking-wider text-zinc-100">
              Hardware &amp; Build Macros — {profileName}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5 bg-slate-950">
          <div className="flex items-center justify-between text-[11px] text-zinc-400 pb-1">
            <span>
              The first 5 macros automatically bind to{" "}
              <code className="text-emerald-300">Alt+1</code> through{" "}
              <code className="text-emerald-300">Alt+5</code>.
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setDrafts(structuredClone(DEFAULT_CLIENT_MACROS))
                }
                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-800 hover:border-zinc-700 bg-zinc-900 text-zinc-300"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Reset Defaults</span>
              </button>
              <button
                type="button"
                onClick={addMacro}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-emerald-700/80 bg-emerald-950/60 hover:bg-emerald-900/60 text-emerald-200"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Macro</span>
              </button>
            </div>
          </div>

          {drafts.length === 0 ? (
            <div className="py-10 text-center text-zinc-500">
              No macros configured for this profile. Click &ldquo;Add Macro&rdquo;
              above.
            </div>
          ) : (
            drafts.map((m, idx) => (
              <div
                key={m.id}
                className="p-3 rounded bg-zinc-900 border border-zinc-800 space-y-2"
              >
                <div className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-1 flex items-center gap-1">
                    <span className="px-1.5 py-0.5 rounded bg-slate-950 border border-zinc-800 text-[10px] text-zinc-400">
                      {idx < 5 ? `Alt+${idx + 1}` : `#${idx + 1}`}
                    </span>
                  </div>

                  <div className="col-span-3">
                    <input
                      required
                      type="text"
                      placeholder="Label (e.g. Build)"
                      value={m.label}
                      onChange={(e) =>
                        updateItem(idx, { label: e.target.value })
                      }
                      className="w-full bg-slate-950 border border-zinc-800 focus:border-emerald-500/80 focus:outline-none rounded px-2 py-1 text-xs text-zinc-100"
                    />
                  </div>

                  <div className="col-span-4">
                    <input
                      required
                      type="text"
                      placeholder="Shell command (e.g. make -j$(nproc))"
                      value={m.command}
                      onChange={(e) =>
                        updateItem(idx, { command: e.target.value })
                      }
                      className="w-full bg-slate-950 border border-zinc-800 focus:border-emerald-500/80 focus:outline-none rounded px-2 py-1 text-xs text-emerald-200"
                    />
                  </div>

                  <div className="col-span-2">
                    <select
                      value={m.accent}
                      onChange={(e) =>
                        updateItem(idx, {
                          accent: e.target.value as MacroAccent,
                        })
                      }
                      className="w-full bg-slate-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200"
                    >
                      {ACCENT_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="col-span-2 flex items-center justify-end gap-1">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => moveItem(idx, -1)}
                      className="p-1 rounded hover:bg-zinc-800 disabled:opacity-30 text-zinc-400"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === drafts.length - 1}
                      onClick={() => moveItem(idx, 1)}
                      className="p-1 rounded hover:bg-zinc-800 disabled:opacity-30 text-zinc-400"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeItem(idx)}
                      className="p-1 rounded hover:bg-rose-950/60 text-zinc-400 hover:text-rose-300"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pl-2 pt-1 border-t border-zinc-800/70 text-[11px]">
                  <div className="flex items-center gap-3">
                    <span className="text-zinc-500 uppercase text-[10px]">
                      Target:
                    </span>
                    {(
                      [
                        ["active_terminal", "Send to Active Terminal"],
                        ["dedicated_tab", "Run in Dedicated Output Tab"],
                      ] as [MacroTargetMode, string][]
                    ).map(([mode, text]) => (
                      <label
                        key={mode}
                        className="inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer"
                      >
                        <input
                          type="radio"
                          name={`target-${m.id}`}
                          checked={m.target_mode === mode}
                          onChange={() =>
                            updateItem(idx, { target_mode: mode })
                          }
                        />
                        <span>{text}</span>
                      </label>
                    ))}
                  </div>

                  <label className="inline-flex items-center gap-1.5 text-emerald-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={m.flush_sync_before_run}
                      onChange={(e) =>
                        updateItem(idx, {
                          flush_sync_before_run: e.target.checked,
                        })
                      }
                    />
                    <span>Flush pending sync before running</span>
                  </label>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="h-12 px-4 bg-zinc-950 border-t border-zinc-800 flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-zinc-800 hover:border-zinc-700 text-zinc-300"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-slate-950 font-semibold"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{saving ? "Saving..." : "Save Macros"}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
