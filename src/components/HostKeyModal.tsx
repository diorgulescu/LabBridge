import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  ShieldAlert,
  ShieldQuestion,
} from "lucide-react";
import type { HostKeyPromptPayload } from "../types/labbridge";

interface HostKeyModalProps {
  prompt: HostKeyPromptPayload | null;
  onRespond: (requestId: string, accept: boolean) => void;
}

export const HostKeyModal: React.FC<HostKeyModalProps> = ({
  prompt,
  onRespond,
}) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
    if (!prompt) return;

    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onRespond(prompt.request_id, false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [prompt, onRespond]);

  if (!prompt) return null;

  const isChanged = prompt.check_status.status === "Changed";

  const copyFingerprint = async () => {
    try {
      await navigator.clipboard.writeText(prompt.fingerprint_sha256);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-key-modal-title"
        className={`w-full max-w-lg rounded border bg-zinc-900 shadow-2xl overflow-hidden ${
          isChanged ? "border-rose-600/80" : "border-amber-600/70"
        }`}
      >
        {/* Header */}
        <div
          className={`px-4 py-3 border-b flex items-center justify-between ${
            isChanged
              ? "bg-rose-950/50 border-rose-800/70"
              : "bg-amber-950/30 border-zinc-800"
          }`}
        >
          <div className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-wider">
            {isChanged ? (
              <ShieldAlert className="w-4 h-4 text-rose-400" />
            ) : (
              <ShieldQuestion className="w-4 h-4 text-amber-400" />
            )}
            <span
              id="host-key-modal-title"
              className={isChanged ? "text-rose-200" : "text-amber-200"}
            >
              {isChanged
                ? "WARNING: REMOTE HOST KEY CHANGED"
                : "VERIFY UNKNOWN SSH HOST KEY (TOFU)"}
            </span>
          </div>
          <span className="px-2 py-0.5 rounded bg-slate-950 border border-zinc-800 font-mono text-[10px] text-zinc-300">
            {prompt.is_jump_host ? "PROXYJUMP BASTION" : "LAB TARGET"}
          </span>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3 text-xs">
          {isChanged ? (
            <div className="p-2.5 rounded bg-rose-950/40 border border-rose-800/70 text-rose-200 flex items-start gap-2 leading-relaxed">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                The host key presented by{" "}
                <span className="font-mono font-semibold">
                  {prompt.host_id}
                </span>{" "}
                differs from the key stored in{" "}
                <code className="font-mono">known_hosts</code>. This could
                indicate a man-in-the-middle attack or that the lab machine was
                re-imaged.
              </div>
            </div>
          ) : (
            <p className="text-zinc-300 leading-relaxed">
              The authenticity of host{" "}
              <span className="font-mono font-semibold text-zinc-100">
                {prompt.host_id}
              </span>{" "}
              cannot be established from your local{" "}
              <code className="font-mono text-zinc-200">known_hosts</code>{" "}
              store. Verify the fingerprint below before trusting this host.
            </p>
          )}

          <div className="bg-slate-950 border border-zinc-800 rounded p-3 space-y-2 font-mono text-xs">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500 text-[11px]">ENDPOINT</span>
              <span className="text-zinc-200">
                {prompt.host}:{prompt.port}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500 text-[11px]">ALGORITHM</span>
              <span className="text-emerald-300">{prompt.key_algorithm}</span>
            </div>

            {prompt.check_status.status === "Changed" && (
              <div className="pt-1.5 border-t border-zinc-800/80">
                <div className="text-rose-400 text-[10px] uppercase mb-1">
                  Previously Trusted Fingerprint
                </div>
                <div className="bg-zinc-900 border border-rose-900/60 rounded px-2 py-1.5 text-[11px] text-rose-300 break-all">
                  {prompt.check_status.previous_fingerprint}
                </div>
              </div>
            )}

            <div className="pt-1.5 border-t border-zinc-800/80">
              <div className="flex items-center justify-between mb-1">
                <span className="text-zinc-400 text-[10px] uppercase">
                  Presented Key Fingerprint (SHA-256)
                </span>
                <button
                  type="button"
                  onClick={copyFingerprint}
                  className="inline-flex items-center gap-1 text-[10px] text-zinc-400 hover:text-zinc-200"
                >
                  {copied ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <div className="bg-zinc-900 border border-zinc-700 rounded px-2.5 py-2 text-[11px] text-amber-200 break-all select-all">
                {prompt.fingerprint_sha256}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 bg-zinc-950 border-t border-zinc-800 flex items-center justify-end gap-2 font-mono text-xs">
          <button
            type="button"
            autoFocus={isChanged}
            onClick={() => onRespond(prompt.request_id, false)}
            className="px-3 py-1.5 rounded border border-zinc-700 hover:border-zinc-600 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 transition-colors"
          >
            Reject &amp; Abort (Esc)
          </button>
          <button
            type="button"
            autoFocus={!isChanged}
            onClick={() => onRespond(prompt.request_id, true)}
            className={`px-3 py-1.5 rounded font-semibold transition-colors ${
              isChanged
                ? "bg-rose-600 hover:bg-rose-500 text-white"
                : "bg-emerald-600 hover:bg-emerald-500 text-slate-950"
            }`}
          >
            {isChanged
              ? "Replace & Trust New Key"
              : "Trust & Save to known_hosts"}
          </button>
        </div>
      </div>
    </div>
  );
};
