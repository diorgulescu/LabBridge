import React, { useEffect, useState } from "react";
import {
  Copy,
  FolderOpen,
  HardDrive,
  KeyRound,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  browseLocalFolder,
  browseSshKeyFile,
  deleteProfile,
  duplicateProfile,
  formatError,
  getProfileSecretStatus,
  listKnownHosts,
  normalizePosixPath,
  removeKnownHost,
  saveProfile,
} from "../lib/ipc";
import type {
  AuthMethod,
  KnownHostEntry,
  ProxyJumpConfig,
  SecretStatus,
  StorageInfo,
  WorkspaceProfile,
} from "../types/labbridge";

interface ProfileManagerModalProps {
  isOpen: boolean;
  startInCreateMode: boolean;
  profiles: WorkspaceProfile[];
  activeProfileId: string | null;
  storageInfo: StorageInfo | null;
  onClose: () => void;
  onProfilesChanged: (selectedId?: string | null) => Promise<void>;
}

function createEmptyProfile(): WorkspaceProfile {
  return {
    id: "",
    name: "",
    host: "",
    port: 22,
    username: "",
    auth_method: {
      type: "PrivateKeyFile",
      path: "~/.ssh/id_ed25519",
      passphrase_in_keyring: false,
    },
    proxy_jump: null,
    local_root_path: "",
    remote_root_path: "/home/",
    keepalive_secs: 15,
    auto_sync_enabled: true,
    crlf_guard_enabled: true,
    sync_deletions: false,
    excluded_dirs: ["build", "out", "target", ".vscode"],
  };
}

function createDefaultJump(): ProxyJumpConfig {
  return {
    host: "",
    port: 22,
    user: "",
    auth: {
      type: "WindowsSshAgent",
    },
  };
}

export const ProfileManagerModal: React.FC<ProfileManagerModalProps> = ({
  isOpen,
  startInCreateMode,
  profiles,
  activeProfileId,
  storageInfo,
  onClose,
  onProfilesChanged,
}) => {
  const [activeTab, setActiveTab] = useState<"profiles" | "storage">(
    "profiles",
  );
  const [draft, setDraft] = useState<WorkspaceProfile>(createEmptyProfile());
  const [targetSecret, setTargetSecret] = useState("");
  const [proxySecret, setProxySecret] = useState("");
  const [secretStatus, setSecretStatus] = useState<SecretStatus>({
    has_target_secret: false,
    has_proxy_secret: false,
  });
  const [knownHosts, setKnownHosts] = useState<KnownHostEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setActiveTab("profiles");
    setErrorMsg(null);
    setStatusBanner(null);
    setTargetSecret("");
    setProxySecret("");

    if (startInCreateMode || profiles.length === 0) {
      setDraft(createEmptyProfile());
      setSecretStatus({ has_target_secret: false, has_proxy_secret: false });
    } else {
      const target =
        profiles.find((p) => p.id === activeProfileId) ?? profiles[0];
      setDraft(structuredClone(target));
      void loadSecretStatus(target.id);
    }

    void refreshKnownHosts();
  }, [isOpen, startInCreateMode]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const loadSecretStatus = async (profileId: string) => {
    if (!profileId) {
      setSecretStatus({ has_target_secret: false, has_proxy_secret: false });
      return;
    }
    try {
      const st = await getProfileSecretStatus(profileId);
      setSecretStatus(st);
    } catch {
      setSecretStatus({ has_target_secret: false, has_proxy_secret: false });
    }
  };

  const refreshKnownHosts = async () => {
    try {
      const list = await listKnownHosts();
      setKnownHosts(list);
    } catch {
      setKnownHosts([]);
    }
  };

  if (!isOpen) return null;

  const selectExistingProfile = (profile: WorkspaceProfile) => {
    setErrorMsg(null);
    setStatusBanner(null);
    setTargetSecret("");
    setProxySecret("");
    setDraft(structuredClone(profile));
    void loadSecretStatus(profile.id);
  };

  const handleNewProfile = () => {
    setErrorMsg(null);
    setStatusBanner(null);
    setTargetSecret("");
    setProxySecret("");
    setDraft(createEmptyProfile());
    setSecretStatus({ has_target_secret: false, has_proxy_secret: false });
  };

  const handleAuthTypeChange = (kind: AuthMethod["type"]) => {
    setTargetSecret("");
    if (kind === "PrivateKeyFile") {
      setDraft((prev) => ({
        ...prev,
        auth_method: {
          type: "PrivateKeyFile",
          path:
            prev.auth_method.type === "PrivateKeyFile"
              ? prev.auth_method.path
              : "~/.ssh/id_ed25519",
          passphrase_in_keyring: false,
        },
      }));
    } else if (kind === "PasswordInKeyring") {
      setDraft((prev) => ({
        ...prev,
        auth_method: { type: "PasswordInKeyring" },
      }));
    } else {
      setDraft((prev) => ({
        ...prev,
        auth_method: { type: "WindowsSshAgent" },
      }));
    }
  };

  const handleJumpAuthTypeChange = (kind: AuthMethod["type"]) => {
    setProxySecret("");
    setDraft((prev) => {
      if (!prev.proxy_jump) return prev;
      let nextAuth: AuthMethod;
      if (kind === "PrivateKeyFile") {
        nextAuth = {
          type: "PrivateKeyFile",
          path:
            prev.proxy_jump.auth.type === "PrivateKeyFile"
              ? prev.proxy_jump.auth.path
              : "~/.ssh/id_ed25519",
          passphrase_in_keyring: false,
        };
      } else if (kind === "PasswordInKeyring") {
        nextAuth = { type: "PasswordInKeyring" };
      } else {
        nextAuth = { type: "WindowsSshAgent" };
      }
      return {
        ...prev,
        proxy_jump: {
          ...prev.proxy_jump,
          auth: nextAuth,
        },
      };
    });
  };

  const handleBrowseTargetKey = async () => {
    try {
      const currentPath =
        draft.auth_method.type === "PrivateKeyFile"
          ? draft.auth_method.path
          : undefined;
      const picked = await browseSshKeyFile(currentPath);
      if (picked && draft.auth_method.type === "PrivateKeyFile") {
        setDraft({
          ...draft,
          auth_method: {
            ...draft.auth_method,
            path: picked,
          },
        });
      }
    } catch (err) {
      setErrorMsg(formatError(err));
    }
  };

  const handleBrowseJumpKey = async () => {
    try {
      const currentPath =
        draft.proxy_jump?.auth.type === "PrivateKeyFile"
          ? draft.proxy_jump.auth.path
          : undefined;
      const picked = await browseSshKeyFile(currentPath);
      if (
        picked &&
        draft.proxy_jump &&
        draft.proxy_jump.auth.type === "PrivateKeyFile"
      ) {
        setDraft({
          ...draft,
          proxy_jump: {
            ...draft.proxy_jump,
            auth: {
              ...draft.proxy_jump.auth,
              path: picked,
            },
          },
        });
      }
    } catch (err) {
      setErrorMsg(formatError(err));
    }
  };

  const handleBrowseLocalRoot = async () => {
    try {
      const picked = await browseLocalFolder(draft.local_root_path);
      if (picked) {
        setDraft({ ...draft, local_root_path: picked });
      }
    } catch (err) {
      setErrorMsg(formatError(err));
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrorMsg(null);
    setStatusBanner(null);

    try {
      const saved = await saveProfile(
        {
          ...draft,
          remote_root_path: normalizePosixPath(draft.remote_root_path),
        },
        targetSecret || null,
        proxySecret || null,
      );
      setDraft(saved);
      setTargetSecret("");
      setProxySecret("");
      await loadSecretStatus(saved.id);
      await onProfilesChanged(saved.id);
      setStatusBanner(`Saved profile "${saved.name}"`);
    } catch (err) {
      setErrorMsg(formatError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDuplicate = async () => {
    if (!draft.id) return;
    setErrorMsg(null);
    try {
      const copy = await duplicateProfile(draft.id);
      await onProfilesChanged(copy.id);
      setDraft(copy);
      await loadSecretStatus(copy.id);
      setStatusBanner(`Duplicated as "${copy.name}"`);
    } catch (err) {
      setErrorMsg(formatError(err));
    }
  };

  const handleDelete = async () => {
    if (!draft.id) return;
    setErrorMsg(null);
    try {
      const deletedId = draft.id;
      await deleteProfile(deletedId);
      const remaining = profiles.filter((p) => p.id !== deletedId);
      const nextProfile = remaining[0] ?? null;
      await onProfilesChanged(nextProfile?.id ?? null);
      if (nextProfile) {
        selectExistingProfile(nextProfile);
      } else {
        handleNewProfile();
      }
      setStatusBanner("Profile deleted and keyring credentials purged");
    } catch (err) {
      setErrorMsg(formatError(err));
    }
  };

  const handleRevokeHost = async (hostId: string, algorithm: string) => {
    try {
      await removeKnownHost(hostId, algorithm);
      await refreshKnownHosts();
    } catch (err) {
      setErrorMsg(formatError(err));
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/75 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-4xl h-[82vh] max-h-[760px] bg-zinc-900 border border-zinc-800 rounded shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Modal Header */}
        <div className="h-11 px-4 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <span className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-100">
              LabBridge Configuration
            </span>
            <div className="flex items-center gap-1 bg-zinc-900 p-0.5 rounded border border-zinc-800 font-mono text-[11px]">
              <button
                type="button"
                onClick={() => setActiveTab("profiles")}
                className={`px-2.5 py-1 rounded transition-colors ${
                  activeTab === "profiles"
                    ? "bg-zinc-800 text-emerald-300"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Workspace Profiles ({profiles.length})
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab("storage");
                  void refreshKnownHosts();
                }}
                className={`px-2.5 py-1 rounded transition-colors ${
                  activeTab === "storage"
                    ? "bg-zinc-800 text-emerald-300"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Known Hosts &amp; Storage ({knownHosts.length})
              </button>
            </div>
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
        {activeTab === "profiles" ? (
          <div className="flex-1 min-h-0 flex">
            {/* Left Rail: Profile List */}
            <aside className="w-64 shrink-0 bg-slate-950 border-r border-zinc-800 flex flex-col">
              <div className="p-2.5 border-b border-zinc-800 flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  Saved Profiles
                </span>
                <button
                  type="button"
                  onClick={handleNewProfile}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-700/70 hover:bg-emerald-900/60 font-mono text-[11px] text-emerald-200"
                >
                  <Plus className="w-3 h-3" />
                  <span>New</span>
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
                {profiles.length === 0 ? (
                  <div className="p-3 text-center font-mono text-[11px] text-zinc-500">
                    No profiles saved yet.
                  </div>
                ) : (
                  profiles.map((p) => {
                    const selected = draft.id === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => selectExistingProfile(p)}
                        className={`w-full text-left px-2.5 py-2 rounded border transition-colors ${
                          selected
                            ? "bg-zinc-900 border-emerald-600/70 text-zinc-100"
                            : "bg-transparent border-transparent hover:bg-zinc-900/60 text-zinc-300"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-mono text-xs font-medium truncate">
                            {p.name}
                          </span>
                          <div className="flex items-center gap-1 shrink-0">
                            {p.proxy_jump && (
                              <span className="px-1 rounded bg-amber-950/60 border border-amber-800/60 font-mono text-[9px] text-amber-300">
                                JMP
                              </span>
                            )}
                            <span className="px-1 rounded bg-zinc-800 font-mono text-[9px] text-zinc-300">
                              {p.auth_method.type === "PrivateKeyFile"
                                ? "KEY"
                                : p.auth_method.type === "PasswordInKeyring"
                                  ? "PWD"
                                  : "AGT"}
                            </span>
                          </div>
                        </div>
                        <div className="font-mono text-[10px] text-zinc-500 truncate mt-0.5">
                          {p.username}@{p.host}:{p.port}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </aside>

            {/* Right Pane: Profile Editor Form */}
            <form
              onSubmit={handleSave}
              className="flex-1 min-w-0 flex flex-col bg-zinc-900"
            >
              <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
                {errorMsg && (
                  <div className="px-3 py-2 rounded bg-rose-950/60 border border-rose-800 text-rose-200 font-mono text-xs">
                    {errorMsg}
                  </div>
                )}
                {statusBanner && (
                  <div className="px-3 py-2 rounded bg-emerald-950/50 border border-emerald-800 text-emerald-200 font-mono text-xs">
                    {statusBanner}
                  </div>
                )}

                {/* Section 1: Endpoint */}
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
                        onChange={(e) =>
                          setDraft({ ...draft, name: e.target.value })
                        }
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
                        onChange={(e) =>
                          setDraft({ ...draft, username: e.target.value })
                        }
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
                          setDraft({
                            ...draft,
                            keepalive_secs: Number(e.target.value) || 15,
                          })
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
                        onChange={(e) =>
                          setDraft({ ...draft, host: e.target.value })
                        }
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
                          setDraft({
                            ...draft,
                            port: Number(e.target.value) || 22,
                          })
                        }
                        className="w-full bg-slate-950 border border-zinc-800 focus:border-emerald-500/80 focus:outline-none rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                      />
                    </div>
                  </div>
                </section>

                {/* Section 2: Target Authentication */}
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
                        onClick={() => handleAuthTypeChange(kind)}
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
                              if (
                                draft.auth_method.type === "PrivateKeyFile"
                              ) {
                                setDraft({
                                  ...draft,
                                  auth_method: {
                                    ...draft.auth_method,
                                    path: e.target.value,
                                  },
                                });
                              }
                            }}
                            className="flex-1 bg-zinc-900 border border-zinc-800 focus:border-emerald-500/80 focus:outline-none rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                          />
                          <button
                            type="button"
                            onClick={handleBrowseTargetKey}
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
                        <span>
                          Encrypted key (store passphrase in Windows Credential
                          Manager)
                        </span>
                      </label>

                      {draft.auth_method.passphrase_in_keyring && (
                        <div>
                          <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
                            Key Passphrase{" "}
                            {secretStatus.has_target_secret && (
                              <span className="text-emerald-400">
                                — Stored in Keyring (leave blank to keep)
                              </span>
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
                            className="w-full bg-zinc-900 border border-zinc-800 focus:border-emerald-500/80 focus:outline-none rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
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
                          <span className="text-emerald-400">
                            — Stored in Keyring (leave blank to keep)
                          </span>
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
                        className="w-full bg-zinc-900 border border-zinc-800 focus:border-emerald-500/80 focus:outline-none rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                      />
                    </div>
                  )}

                  {draft.auth_method.type === "WindowsSshAgent" && (
                    <div className="bg-slate-950 border border-zinc-800 rounded p-3 font-mono text-[11px] text-zinc-400">
                      Connects directly to Windows native OpenSSH Agent over
                      named pipe{" "}
                      <code className="text-emerald-300">
                        \\.\pipe\openssh-ssh-agent
                      </code>{" "}
                      with zero key material stored by LabBridge.
                    </div>
                  )}
                </section>

                {/* Section 3: Optional ProxyJump */}
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
                            proxy_jump: e.target.checked
                              ? createDefaultJump()
                              : null,
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
                                proxy_jump: draft.proxy_jump
                                  ? {
                                      ...draft.proxy_jump,
                                      host: e.target.value,
                                    }
                                  : null,
                              })
                            }
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
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
                                proxy_jump: draft.proxy_jump
                                  ? {
                                      ...draft.proxy_jump,
                                      user: e.target.value,
                                    }
                                  : null,
                              })
                            }
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
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
                                  ? {
                                      ...draft.proxy_jump,
                                      port: Number(e.target.value) || 22,
                                    }
                                  : null,
                              })
                            }
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
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
                            onClick={() => handleJumpAuthTypeChange(kind)}
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
                                if (
                                  draft.proxy_jump &&
                                  draft.proxy_jump.auth.type ===
                                    "PrivateKeyFile"
                                ) {
                                  setDraft({
                                    ...draft,
                                    proxy_jump: {
                                      ...draft.proxy_jump,
                                      auth: {
                                        ...draft.proxy_jump.auth,
                                        path: e.target.value,
                                      },
                                    },
                                  });
                                }
                              }}
                              className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                            />
                            <button
                              type="button"
                              onClick={handleBrowseJumpKey}
                              className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 font-mono text-xs text-zinc-200"
                            >
                              Browse...
                            </button>
                          </div>

                          <label className="inline-flex items-center gap-2 font-mono text-[11px] text-zinc-300 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={
                                draft.proxy_jump.auth.passphrase_in_keyring
                              }
                              onChange={(e) => {
                                if (
                                  draft.proxy_jump &&
                                  draft.proxy_jump.auth.type ===
                                    "PrivateKeyFile"
                                ) {
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
                              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
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
                          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                        />
                      )}
                    </div>
                  )}
                </section>

                {/* Section 4: Local & Remote Workspace Paths */}
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
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              local_root_path: e.target.value,
                            })
                          }
                          className="flex-1 bg-slate-950 border border-zinc-800 rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                        />
                        <button
                          type="button"
                          onClick={handleBrowseLocalRoot}
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
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            remote_root_path: e.target.value,
                          })
                        }
                        onBlur={() =>
                          setDraft((prev) => ({
                            ...prev,
                            remote_root_path: normalizePosixPath(
                              prev.remote_root_path,
                            ),
                          }))
                        }
                        className="w-full bg-slate-950 border border-zinc-800 rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block font-mono text-[10px] uppercase text-zinc-400 mb-1">
                      Hard-Excluded Build Folders (comma-separated; .git &amp;
                      .gitignore/.labignore always applied)
                    </label>
                    <input
                      type="text"
                      placeholder="build, out, target, .vscode"
                      value={(
                        draft.excluded_dirs ?? [
                          "build",
                          "out",
                          "target",
                          ".vscode",
                        ]
                      ).join(", ")}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          excluded_dirs: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      className="w-full bg-slate-950 border border-zinc-800 rounded px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                    />
                  </div>
                </section>
              </div>

              {/* Editor Action Footer */}
              <div className="h-12 px-4 bg-zinc-950 border-t border-zinc-800 flex items-center justify-between shrink-0 font-mono text-xs">
                <div className="flex items-center gap-2">
                  {draft.id && (
                    <>
                      <button
                        type="button"
                        onClick={handleDuplicate}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-zinc-800 hover:border-zinc-700 bg-zinc-900 text-zinc-300"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        <span>Duplicate</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleDelete}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-rose-900/70 hover:bg-rose-950/60 text-rose-300"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete</span>
                      </button>
                    </>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-3 py-1.5 rounded border border-zinc-800 hover:border-zinc-700 text-zinc-300"
                  >
                    Close
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-slate-950 font-semibold"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{saving ? "Saving..." : "Save Profile"}</span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        ) : (
          /* Storage & Known Hosts Tab */
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
                    <span className="text-zinc-200 select-all">
                      {storageInfo.data_dir}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Profiles JSON: </span>
                    <span className="text-zinc-300 select-all">
                      {storageInfo.profiles_file}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Known Hosts: </span>
                    <span className="text-zinc-300 select-all">
                      {storageInfo.known_hosts_file}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Logs Directory: </span>
                    <span className="text-zinc-300 select-all">
                      {storageInfo.logs_dir}
                    </span>
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
                <span className="text-[11px] text-zinc-500">
                  {knownHosts.length} entries
                </span>
              </div>

              {knownHosts.length === 0 ? (
                <div className="py-6 text-center font-mono text-xs text-zinc-500">
                  No host keys trusted yet. Connect to a host to verify via
                  TOFU.
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
                          <span className="text-zinc-100 font-semibold">
                            {entry.host_id}
                          </span>
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
                        onClick={() =>
                          handleRevokeHost(entry.host_id, entry.algorithm)
                        }
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
        )}
      </div>
    </div>
  );
};
