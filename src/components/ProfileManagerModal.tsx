import React, { useEffect, useState } from "react";
import { Copy, Plus, Save, Trash2, X } from "lucide-react";
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
import { ProfileEndpointSection } from "./profile/ProfileEndpointSection";
import { ProfileAuthSection } from "./profile/ProfileAuthSection";
import { ProfileProxyJumpSection } from "./profile/ProfileProxyJumpSection";
import { ProfilePathsSection } from "./profile/ProfilePathsSection";
import { KnownHostsPanel } from "./profile/KnownHostsPanel";
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

export function createEmptyProfile(): WorkspaceProfile {
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

export function createDefaultJump(): ProxyJumpConfig {
  return {
    host: "",
    port: 22,
    user: "",
    auth: { type: "WindowsSshAgent" },
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
  const [activeTab, setActiveTab] = useState<"profiles" | "storage">("profiles");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, startInCreateMode]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
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
      setKnownHosts(await listKnownHosts());
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
      setDraft((prev) => ({ ...prev, auth_method: { type: "PasswordInKeyring" } }));
    } else {
      setDraft((prev) => ({ ...prev, auth_method: { type: "WindowsSshAgent" } }));
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
      return { ...prev, proxy_jump: { ...prev.proxy_jump, auth: nextAuth } };
    });
  };

  const handleBrowseTargetKey = async () => {
    try {
      const currentPath =
        draft.auth_method.type === "PrivateKeyFile" ? draft.auth_method.path : undefined;
      const picked = await browseSshKeyFile(currentPath);
      if (picked && draft.auth_method.type === "PrivateKeyFile") {
        setDraft({
          ...draft,
          auth_method: { ...draft.auth_method, path: picked },
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
      if (picked && draft.proxy_jump && draft.proxy_jump.auth.type === "PrivateKeyFile") {
        setDraft({
          ...draft,
          proxy_jump: {
            ...draft.proxy_jump,
            auth: { ...draft.proxy_jump.auth, path: picked },
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
      if (picked) setDraft({ ...draft, local_root_path: picked });
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
        { ...draft, remote_root_path: normalizePosixPath(draft.remote_root_path) },
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
      if (nextProfile) selectExistingProfile(nextProfile);
      else handleNewProfile();
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
        {/* Header */}
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
                          <span className="font-mono text-xs font-medium truncate">{p.name}</span>
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
            <form onSubmit={handleSave} className="flex-1 min-w-0 flex flex-col bg-zinc-900">
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

                <ProfileEndpointSection draft={draft} setDraft={setDraft} />
                <ProfileAuthSection
                  draft={draft}
                  setDraft={setDraft}
                  targetSecret={targetSecret}
                  setTargetSecret={setTargetSecret}
                  secretStatus={secretStatus}
                  onBrowseKey={handleBrowseTargetKey}
                  onAuthTypeChange={handleAuthTypeChange}
                />
                <ProfileProxyJumpSection
                  draft={draft}
                  setDraft={setDraft}
                  proxySecret={proxySecret}
                  setProxySecret={setProxySecret}
                  secretStatus={secretStatus}
                  onJumpAuthTypeChange={handleJumpAuthTypeChange}
                  onBrowseJumpKey={handleBrowseJumpKey}
                  onCreateDefaultJump={createDefaultJump}
                />
                <ProfilePathsSection
                  draft={draft}
                  setDraft={setDraft}
                  onBrowseLocalRoot={handleBrowseLocalRoot}
                />
              </div>

              {/* Footer */}
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
          <KnownHostsPanel
            storageInfo={storageInfo}
            knownHosts={knownHosts}
            onRevoke={handleRevokeHost}
          />
        )}
      </div>
    </div>
  );
};
