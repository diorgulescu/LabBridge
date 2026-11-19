import React from "react";
import type { AuthMethod, SecretStatus, WorkspaceProfile } from "../../types/labbridge";

interface Props {
  draft: WorkspaceProfile;
  setDraft: React.Dispatch<React.SetStateAction<WorkspaceProfile>>;
  proxySecret: string;
  setProxySecret: (v: string) => void;
  secretStatus: SecretStatus;
  onJumpAuthTypeChange: (kind: AuthMethod["type"]) => void;
  onBrowseJumpKey: () => void;
  onCreateDefaultJump: () => import("../../types/labbridge").ProxyJumpConfig;
}

const inputCls =
  "w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100";

/** Section 3: Optional ProxyJump (bastion tunnel) configuration. */
export const ProfileProxyJumpSection: React.FC<Props> = ({
  draft,
  setDraft,
  proxySecret,
  setProxySecret,
  secretStatus,
  onJumpAuthTypeChange,
  onBrowseJumpKey,
  onCreateDefaultJump,
}) => (
  <section className="space-y-2.5">
    <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-400 border-b border-zinc-800 pb-1 flex items-center justify-between">
      <span>3. ProxyJump (Bastion Tunnel)</span>
      <label className="inline-flex items-center gap-2 font-normal text-zinc-300 cursor-pointer normal-case">
        <input
          type="checkbox"
          checked={draft.proxy_jump !== null}
          onChange={(e) =>
            setDraft({
              ...draft,
              proxy_jump: e.target.checked ? onCreateDefaultJump() : null,
            })
          }
          className="rounded border-zinc-700 bg-zinc-900 text-emerald-500"
        />
        <span>Enable ProxyJump</span>
      </label>
    </div>

    {draft.proxy_jump && (
      <div className="bg-slate-950 border border-zinc-800 rounded p-3 space-y-3">
        <div className="grid grid-cols-12 gap-2">
          <div className="col-span-6">
            <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
              Bastion Host *
            </label>
            <input
              required
              type="text"
              placeholder="bastion.corp.example.com"
              value={draft.proxy_jump.host}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  proxy_jump: draft.proxy_jump ? { ...draft.proxy_jump, host: e.target.value } : null,
                })
              }
              className={inputCls}
            />
          </div>
          <div className="col-span-4">
            <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
              Bastion User *
            </label>
            <input
              required
              type="text"
              placeholder="jumpuser"
              value={draft.proxy_jump.user}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  proxy_jump: draft.proxy_jump ? { ...draft.proxy_jump, user: e.target.value } : null,
                })
              }
              className={inputCls}
            />
          </div>
          <div className="col-span-2">
            <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
              Port
            </label>
            <input
              type="number"
              min={1}
              max={65535}
              value={draft.proxy_jump.port}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  proxy_jump: draft.proxy_jump
                    ? { ...draft.proxy_jump, port: Number(e.target.value) || 22 }
                    : null,
                })
              }
              className={inputCls}
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
          {(
            [
              ["PrivateKeyFile", "Jump Key File"],
              ["PasswordInKeyring", "Jump Password"],
              ["WindowsSshAgent", "Windows SSH Agent"],
            ] as const
          ).map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              onClick={() => onJumpAuthTypeChange(kind)}
              className={`px-2 py-1 rounded border text-left ${
                draft.proxy_jump?.auth.type === kind
                  ? "bg-amber-950/40 border-amber-600/80 text-amber-200"
                  : "bg-zinc-900 border-zinc-800 text-zinc-400"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {draft.proxy_jump.auth.type === "PrivateKeyFile" && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                required
                type="text"
                placeholder="Bastion SSH key path"
                value={draft.proxy_jump.auth.path}
                onChange={(e) => {
                  if (draft.proxy_jump && draft.proxy_jump.auth.type === "PrivateKeyFile") {
                    setDraft({
                      ...draft,
                      proxy_jump: {
                        ...draft.proxy_jump,
                        auth: { ...draft.proxy_jump.auth, path: e.target.value },
                      },
                    });
                  }
                }}
                className={`flex-1 ${inputCls}`}
              />
              <button
                type="button"
                onClick={onBrowseJumpKey}
                className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 font-mono text-xs text-zinc-200"
              >
                Browse...
              </button>
            </div>

            <label className="inline-flex items-center gap-2 font-mono text-[11px] text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.proxy_jump.auth.passphrase_in_keyring}
                onChange={(e) => {
                  if (draft.proxy_jump && draft.proxy_jump.auth.type === "PrivateKeyFile") {
                    setDraft({
                      ...draft,
                      proxy_jump: {
                        ...draft.proxy_jump,
                        auth: {
                          ...draft.proxy_jump.auth,
                          passphrase_in_keyring: e.target.checked,
                        },
                      },
                    });
                  }
                }}
              />
              <span>Jump key has passphrase in Keyring</span>
            </label>

            {draft.proxy_jump.auth.passphrase_in_keyring && (
              <input
                type="password"
                placeholder={
                  secretStatus.has_proxy_secret
                    ? "•••••••• (saved in keyring)"
                    : "Jump key passphrase"
                }
                value={proxySecret}
                onChange={(e) => setProxySecret(e.target.value)}
                className={inputCls}
              />
            )}
          </div>
        )}

        {draft.proxy_jump.auth.type === "PasswordInKeyring" && (
          <input
            type="password"
            placeholder={
              secretStatus.has_proxy_secret
                ? "•••••••• (saved in keyring)"
                : "Enter Bastion SSH password"
            }
            value={proxySecret}
            onChange={(e) => setProxySecret(e.target.value)}
            className={inputCls}
          />
        )}
      </div>
    )}
  </section>
);
