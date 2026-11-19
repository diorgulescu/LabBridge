import React from "react";
import { HardDrive, ShieldCheck } from "lucide-react";
import type { KnownHostEntry, StorageInfo } from "../../types/labbridge";

interface Props {
  storageInfo: StorageInfo | null;
  knownHosts: KnownHostEntry[];
  onRevoke: (hostId: string, algorithm: string) => void;
}

/** Storage info + known hosts management panel (second tab of the profile modal). */
export const KnownHostsPanel: React.FC<Props> = ({ storageInfo, knownHosts, onRevoke }) => (
  <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
    {storageInfo && (
      <div className="bg-slate-950 border border-zinc-800 rounded p-3.5 space-y-2 font-mono">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
          <div className="flex items-center gap-2 text-zinc-200 font-semibold">
            <HardDrive className="w-4 h-4 text-emerald-400" />
            <span>Zero-Admin Path Resolution</span>
          </div>
          <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-emerald-300">
            {storageInfo.is_portable
              ? "PORTABLE MODE (./data/)"
              : "STANDARD MODE (%APPDATA%\\LabBridge)"}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-1.5 text-[11px]">
          <div>
            <span className="text-zinc-500">Data Root: </span>
            <span className="text-zinc-200 select-all">{storageInfo.data_dir}</span>
          </div>
          <div>
            <span className="text-zinc-500">Profiles JSON: </span>
            <span className="text-zinc-300 select-all">{storageInfo.profiles_file}</span>
          </div>
          <div>
            <span className="text-zinc-500">Known Hosts: </span>
            <span className="text-zinc-300 select-all">{storageInfo.known_hosts_file}</span>
          </div>
          <div>
            <span className="text-zinc-500">Logs Directory: </span>
            <span className="text-zinc-300 select-all">{storageInfo.logs_dir}</span>
          </div>
        </div>
      </div>
    )}

    <div className="bg-slate-950 border border-zinc-800 rounded p-3.5 space-y-2.5">
      <div className="flex items-center justify-between border-b border-zinc-800 pb-2 font-mono">
        <div className="flex items-center gap-2 text-zinc-200 font-semibold">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>Trusted SSH Host Fingerprints (known_hosts)</span>
        </div>
        <span className="text-[11px] text-zinc-500">{knownHosts.length} entries</span>
      </div>

      {knownHosts.length === 0 ? (
        <div className="py-6 text-center font-mono text-xs text-zinc-500">
          No host keys trusted yet. Connect to a host to verify via TOFU.
        </div>
      ) : (
        <div className="divide-y divide-zinc-800/80 font-mono text-[11px]">
          {knownHosts.map((entry) => (
            <div
              key={`${entry.host_id}-${entry.algorithm}`}
              className="py-2 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-100 font-semibold">{entry.host_id}</span>
                  <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[10px] text-emerald-300">
                    {entry.algorithm}
                  </span>
                </div>
                <div className="text-zinc-400 truncate select-all mt-0.5">
                  {entry.fingerprint_sha256}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onRevoke(entry.host_id, entry.algorithm)}
                className="px-2 py-1 rounded border border-rose-900/70 hover:bg-rose-950/60 text-rose-300 shrink-0"
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
);
