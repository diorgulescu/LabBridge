import React from "react";
import { FolderOpen } from "lucide-react";
import { normalizePosixPath } from "../../lib/ipc";
import type { WorkspaceProfile } from "../../types/labbridge";

interface Props {
  draft: WorkspaceProfile;
  setDraft: React.Dispatch<React.SetStateAction<WorkspaceProfile>>;
  onBrowseLocalRoot: () => void;
}

const inputCls =
  "w-full bg-slate-950 border border-zinc-800 rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100";

/** Section 4: Local Windows root path, remote Linux POSIX root path, and excluded dirs. */
export const ProfilePathsSection: React.FC<Props> = ({
  draft,
  setDraft,
  onBrowseLocalRoot,
}) => (
  <section className="space-y-2.5">
    <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-400 border-b border-zinc-800 pb-1">
      4. Workspace Directories (One-Way Local → Remote)
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
      <div>
        <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
          Local Windows Root Path
        </label>
        <div className="flex gap-1.5">
          <input
            type="text"
            placeholder="C:\work\firmware"
            value={draft.local_root_path}
            onChange={(e) => setDraft({ ...draft, local_root_path: e.target.value })}
            className={`flex-1 ${inputCls}`}
          />
          <button
            type="button"
            onClick={onBrowseLocalRoot}
            title="Browse Local Directory"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-slate-950 hover:bg-zinc-800 border border-zinc-800 font-mono text-xs text-zinc-200"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div>
        <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
          Remote Linux POSIX Root Path
        </label>
        <input
          type="text"
          placeholder="/home/ubuntu/firmware"
          value={draft.remote_root_path}
          onChange={(e) => setDraft({ ...draft, remote_root_path: e.target.value })}
          onBlur={() =>
            setDraft((prev) => ({
              ...prev,
              remote_root_path: normalizePosixPath(prev.remote_root_path),
            }))
          }
          className={inputCls}
        />
      </div>
    </div>

    <div>
      <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
        Hard-Excluded Build Folders (comma-separated; .git &amp; .gitignore/.labignore always applied)
      </label>
      <input
        type="text"
        placeholder="build, out, target, .vscode"
        value={(draft.excluded_dirs ?? ["build", "out", "target", ".vscode"]).join(", ")}
        onChange={(e) =>
          setDraft({
            ...draft,
            excluded_dirs: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
          })
        }
        className={inputCls}
      />
    </div>
  </section>
);
