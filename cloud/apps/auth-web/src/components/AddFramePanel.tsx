"use client";

import {
  Copy,
  MonitorSmartphone,
  Plus,
  QrCode,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Esp32CloudFlasher } from "./Esp32CloudFlasher";
import { SdImageBuilder } from "./SdImageBuilder";

// "Add frame": four enrollment paths (install script, SD image, link code,
// ESP32 USB flashing). Claim codes are plumbing, not UX: a single-use code
// is minted automatically when the panel opens and embedded where it is
// needed (the install command, the setup-portal paste); the SD builder and
// the ESP32 flasher mint their own. The server stores only hashes; every
// enrolled frame appears as pending until the owner confirms it.
export function AddFramePanel() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [claimToken, setClaimToken] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [installCopied, setInstallCopied] = useState(false);
  const [portalCopied, setPortalCopied] = useState(false);
  // Multi-use token for the SD image builder: one personalized image can be
  // flashed to many cards, each boot enrolling a distinct frame. Minted once
  // per panel session, on the first build.
  const [multiUseToken, setMultiUseToken] = useState<string | undefined>();
  const [multiUseExpiresAt, setMultiUseExpiresAt] = useState<
    string | undefined
  >();
  const mintedRef = useRef(false);

  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://cloud.frameos.net";
  const installCommand = claimToken
    ? `curl -fsSL ${origin}/install.sh | sudo FRAMEOS_CLOUD_URL=${origin} FRAMEOS_CLAIM_TOKEN=${claimToken} sh`
    : undefined;

  // Mint the panel's single-use code as soon as it opens, so every command
  // shown below just works without the user handling codes. The ref guards
  // React strict-mode double effects from minting twice.
  useEffect(() => {
    if (!open || mintedRef.current) {
      return;
    }
    mintedRef.current = true;
    void (async () => {
      try {
        const response = await fetch("/api/frames/claim-tokens", {
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const data = (await response.json().catch(() => ({}))) as {
          claim_token?: string;
          error?: string;
        };
        if (!response.ok || !data.claim_token) {
          setError(data.error ?? "claim_token_failed");
          mintedRef.current = false;
          return;
        }
        setClaimToken(data.claim_token);
      } catch {
        setError("network_error");
        mintedRef.current = false;
      }
    })();
  }, [open]);

  async function copyText(text: string, setFlag: (value: boolean) => void) {
    await navigator.clipboard.writeText(text);
    setFlag(true);
    setTimeout(() => setFlag(false), 2000);
  }

  // Passed to SdImageBuilder; the multi_use flag is forwarded to the claim
  // token endpoint so one token covers many enrollments.
  async function mintClaimToken({
    multiUse,
  }: {
    multiUse: boolean;
  }): Promise<string> {
    if (multiUse && multiUseToken) {
      return multiUseToken;
    }
    const response = await fetch("/api/frames/claim-tokens", {
      body: JSON.stringify(multiUse ? { multi_use: true } : {}),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const data = (await response.json()) as {
      claim_token?: string;
      error?: string;
      expires_at?: string;
    };
    if (!response.ok || !data.claim_token) {
      throw new Error(data.error ?? "claim_token_failed");
    }
    if (multiUse) {
      setMultiUseToken(data.claim_token);
      setMultiUseExpiresAt(data.expires_at);
    }
    return data.claim_token;
  }

  if (!open) {
    return (
      <button
        className="button button--small"
        onClick={() => setOpen(true)}
        type="button"
      >
        <Plus aria-hidden size={18} />
        Add frame
      </button>
    );
  }

  return (
    <div className="card" style={{ marginTop: "0.75rem", width: "100%" }}>
      <div className="content-header compact-header">
        <div>
          <h3>Add a frame</h3>
          <p className="copy">
            Pick whichever path fits your hardware. New frames appear here as{" "}
            <em>pending</em> until you confirm them.
          </p>
        </div>
        <div className="inline-actions">
          <input
            className="input"
            maxLength={256}
            onChange={(event) => setName(event.target.value)}
            placeholder="Frame name (optional)"
            value={name}
          />
          <button
            className="button button--subtle button--small"
            onClick={() => {
              // The session code is single-use and may have been spent by an
              // install; reopening mints a fresh one. The SD builder's
              // multi-use token is kept — it lives inside downloaded images.
              setOpen(false);
              setClaimToken(undefined);
              setError(undefined);
              mintedRef.current = false;
            }}
            type="button"
          >
            Close
          </button>
        </div>
      </div>
      {error ? (
        <p className="copy" style={{ color: "var(--warning)" }}>
          Could not prepare the enrollment ({error}) — reload and try again,
          or check whether you hit the frame limit.
        </p>
      ) : null}

      <div className="grid" style={{ gap: "0.75rem", marginTop: "0.75rem" }}>
        <div className="card">
          <h4>
            <TerminalSquare aria-hidden size={18} /> Install script (any Pi /
            most Linux)
          </h4>
          <p className="copy">
            Already running Raspberry Pi OS — or Debian/Ubuntu on any Pi or
            other Linux box? Run this on the device; it installs FrameOS, asks
            a few questions about your display, and links the frame here:
          </p>
          <pre className="copy" style={{ overflowX: "auto", userSelect: "all" }}>
            {installCommand ?? "Preparing the command…"}
          </pre>
          <button
            className="button button--subtle button--small"
            disabled={!installCommand}
            onClick={() =>
              installCommand
                ? void copyText(installCommand, setInstallCopied)
                : undefined
            }
            type="button"
          >
            <Copy aria-hidden size={16} />
            {installCopied ? "Copied" : "Copy command"}
          </button>
        </div>
        <div className="card">
          <h4>
            <MonitorSmartphone aria-hidden size={18} /> SD card image
            (Raspberry Pi)
          </h4>
          <SdImageBuilder
            claimToken={multiUseToken}
            claimTokenExpiresAt={multiUseExpiresAt}
            mintClaimToken={mintClaimToken}
          />
        </div>
        <div className="card">
          <h4>
            <QrCode aria-hidden size={18} /> Link an existing frame
          </h4>
          <p className="copy">
            On the frame&apos;s admin page (Settings → FrameOS Cloud), choose
            Connect and approve the code it shows on the{" "}
            <a href="/device">device page</a>. Or, in the frame&apos;s
            <code> FrameOS-Setup</code> portal, paste this one-time code:
          </p>
          <p>
            <code style={{ userSelect: "all" }}>
              {claimToken ?? "preparing…"}
            </code>{" "}
            <button
              className="button button--subtle button--small"
              disabled={!claimToken}
              onClick={() =>
                claimToken
                  ? void copyText(claimToken, setPortalCopied)
                  : undefined
              }
              type="button"
            >
              <Copy aria-hidden size={16} />
              {portalCopied ? "Copied" : "Copy"}
            </button>
          </p>
        </div>
        <Esp32CloudFlasher frameName={name || undefined} />
      </div>
    </div>
  );
}
