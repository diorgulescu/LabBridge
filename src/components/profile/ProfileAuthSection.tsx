import React from "react";
import { KeyRound } from "lucide-react";
import type { AuthMethod, SecretStatus, WorkspaceProfile } from "../../types/labbridge";

interface Props {
  draft: WorkspaceProfile;
  setDraft: React.Dispatch<React.SetStateAction<WorkspaceProfile>>;
  targetSecret: string;
  setTargetSecret: (v: string) => void;
  secretStatus: SecretStatus;
  onBrowseKey: () => void;
  onAuthTypeChange: (kind: AuthMethod["type"]) => void;
}

const innerInputCls =
  "w-full bg-zinc-900 border border-zinc-800 focus:border-emerald-500/80 focus:outline-none rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100";

/** Section 2: Target authentication (key file, password in keyring, or SSH agent). */
export const ProfileAuthSection: React.FC<Props> = ({
  draft,
  setDraft,
  targetSecret,
  setTargetSecret,
  secretStatus,
  onBrowseKey,
  onAuthTypeChange,
}) => (
  <section className="space-y-2.5">
    <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-400 border-b border-zinc-800 pb-1 flex items-center justify-between">
      <span>2. Authentication &amp; Keyring</span>
      <span className="text-[10px] text-emerald-400 font-normal">
        Secrets stored strictly in OS Keyring
      </span>
    </div>

    <div className="grid grid-cols-3 gap-2 font-mono text-xs">
      {(
        [
          ["PrivateKeyFile", "Private Key File"],
          ["PasswordInKeyring", "Password (Keyring)"],
          ["WindowsSshAgent", "Windows SSH Agent"],
        ] as const
      ).map(([kind, label]) => (
        <button
          key={kind}
          type="button"
          onClick={() => onAuthTypeChange(kind)}
          className={`px-2.5 py-1.5 rounded border text-left transition-colors ${
            draft.auth_method.type === kind
              ? "bg-emerald-950/50 border-emerald-600/80 text-emerald-200"
              : "bg-slate-950 border-zinc-800 hover:border-zinc-700 text-zinc-400"
          }`}
        >
          {label}
        </button>
      ))}
    </div>

    {draft.auth_method.type === "PrivateKeyFile" && (
      <div className="bg-slate-950 border border-zinc-800 rounded p-3 space-y-2.5">
        <div>
          <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
            Private Key Path (Ed25519 / ECDSA / RSA)
          </label>
          <div className="flex gap-2">
            <input
              required
              type="text"
              placeholder="C:\Users\engineer\.ssh\id_ed25519"
              value={draft.auth_method.path}
              onChange={(e) => {
                if (draft.auth_method.type === "PrivateKeyFile") {
                  setDraft({
                    ...draft,
                    auth_method: { ...draft.auth_method, path: e.target.value },
                  });
                }
              }}
              className={`flex-1 ${innerInputCls}`}
            />
            <button
              type="button"
              onClick={onBrowseKey}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 font-mono text-xs text-zinc-200"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>Browse...</span>
            </button>
          </div>
        </div>

        <label className="inline-flex items-center gap-2 font-mono text-xs text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={draft.auth_method.passphrase_in_keyring}
            onChange={(e) => {
              if (draft.auth_method.type === "PrivateKeyFile") {
                setDraft({
                  ...draft,
                  auth_method: {
                    ...draft.auth_method,
                    passphrase_in_keyring: e.target.checked,
                  },
                });
              }
            }}
            className="rounded border-zinc-700 bg-zinc-900 text-emerald-500"
          />
          <span>Encrypted key (store passphrase in Windows Credential Manager)</span>
        </label>

        {draft.auth_method.passphrase_in_keyring && (
          <div>
            <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
              Key Passphrase{" "}
              {secretStatus.has_target_secret && (
                <span className="text-emerald-400">— Stored in Keyring (leave blank to keep)</span>
              )}
            </label>
            <input
              type="password"
              placeholder={
                secretStatus.has_target_secret
                  ? "•••••••••••• (saved in keyring)"
                  : "Enter key passphrase"
              }
              value={targetSecret}
              onChange={(e) => setTargetSecret(e.target.value)}
              className={innerInputCls}
            />
          </div>
        )}
      </div>
    )}

    {draft.auth_method.type === "PasswordInKeyring" && (
      <div className="bg-slate-950 border border-zinc-800 rounded p-3">
        <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
          SSH Password{" "}
          {secretStatus.has_target_secret && (
            <span className="text-emerald-400">— Stored in Keyring (leave blank to keep)</span>
          )}
        </label>
        <input
          type="password"
          placeholder={
            secretStatus.has_target_secret
              ? "•••••••••••• (saved in Windows Credential Manager)"
              : "Enter SSH password"
          }
          value={targetSecret}
          onChange={(e) => setTargetSecret(e.target.value)}
          className={innerInputCls}
        />
      </div>
    )}

    {draft.auth_method.type === "WindowsSshAgent" && (
      <div className="bg-slate-950 border border-zinc-800 rounded p-3 font-mono text-[11px] text-zinc-400">
        Connects directly to Windows native OpenSSH Agent over named pipe{" "}
        <code className="text-emerald-300">\\.\pipe\openssh-ssh-agent</code>{" "}
        with zero key material stored by LabBridge.
      </div>
    )}
  </section>
);
