import React from "react";
import type { WorkspaceProfile } from "../../types/labbridge";

interface Props {
  draft: WorkspaceProfile;
  setDraft: React.Dispatch<React.SetStateAction<WorkspaceProfile>>;
}

/** Section 1: Target lab host endpoint (name, host, port, username, keepalive). */
export const ProfileEndpointSection: React.FC<Props> = ({ draft, setDraft }) => (
  <section className="space-y-2.5">
    <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-400 border-b border-zinc-800 pb-1">
      1. Target Lab Host
    </div>
    <div className="grid grid-cols-12 gap-2.5">
      <div className="col-span-12 sm:col-span-6">
        <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
          Profile Name *
        </label>
        <input
          required
          type="text"
          placeholder="FPGA Build Server"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className="w-full bg-slate-950 border border-zinc-800 focus:border-emerald-500/80 focus:outline-none rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
        />
      </div>
      <div className="col-span-6 sm:col-span-3">
        <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
          SSH Username *
        </label>
        <input
          required
          type="text"
          placeholder="ubuntu"
          value={draft.username}
          onChange={(e) => setDraft({ ...draft, username: e.target.value })}
          className="w-full bg-slate-950 border border-zinc-800 focus:border-emerald-500/80 focus:outline-none rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
        />
      </div>
      <div className="col-span-6 sm:col-span-3">
        <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
          Keepalive (sec)
        </label>
        <input
          type="number"
          min={5}
          max={300}
          value={draft.keepalive_secs}
          onChange={(e) =>
            setDraft({ ...draft, keepalive_secs: Number(e.target.value) || 15 })
          }
          className="w-full bg-slate-950 border border-zinc-800 focus:border-emerald-500/80 focus:outline-none rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
        />
      </div>

      <div className="col-span-9">
        <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
          Target Host / IP *
        </label>
        <input
          required
          type="text"
          placeholder="10.24.8.120 or lab-gpu-01.internal"
          value={draft.host}
          onChange={(e) => setDraft({ ...draft, host: e.target.value })}
          className="w-full bg-slate-950 border border-zinc-800 focus:border-emerald-500/80 focus:outline-none rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
        />
      </div>
      <div className="col-span-3">
        <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
          Port
        </label>
        <input
          type="number"
          min={1}
          max={65535}
          value={draft.port}
          onChange={(e) =>
            setDraft({ ...draft, port: Number(e.target.value) || 22 })
          }
          className="w-full bg-slate-950 border border-zinc-800 focus:border-emerald-500/80 focus:outline-none rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
        />
      </div>
    </div>
  </section>
);
