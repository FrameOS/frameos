"use client";

import {
  Copy,
  MonitorSmartphone,
  Plus,
  QrCode,
  TerminalSquare,
} from "lucide-react";
import { useState } from "react";
import { Esp32CloudFlasher } from "./Esp32CloudFlasher";

// "Add frame": mints a single-use claim token and walks through the three
// enrollment paths (SD image, link code on the device, ESP32 USB flashing).
// The token is displayed exactly once — the server stores only a hash.
export function AddFramePanel() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [claimToken, setClaimToken] = useState<string | undefined>();
  const [expiresAt, setExpiresAt] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [installCopied, setInstallCopied] = useState(false);

  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://cloud.frameos.net";
  const installCommand = `curl -fsSL ${origin}/install.sh | sudo FRAMEOS_CLOUD_URL=${origin} FRAMEOS_CLAIM_TOKEN=${claimToken ?? "<your claim code>"} sh`;

  async function copyText(
    text: string,
    setFlag: (value: boolean) => void,
  ) {
    await navigator.clipboard.writeText(text);
    setFlag(true);
    setTimeout(() => setFlag(false), 2000);
  }

  async function mintToken() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/frames/claim-tokens", {
        body: JSON.stringify(name ? { name } : {}),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const data = (await response.json()) as {
        claim_token?: string;
        error?: string;
        expires_at?: string;
      };
      if (!response.ok || !data.claim_token) {
        setError(data.error ?? "claim_token_failed");
        return;
      }
      setClaimToken(data.claim_token);
      setExpiresAt(data.expires_at);
    } catch {
      setError("network_error");
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!claimToken) {
      return;
    }
    await navigator.clipboard.writeText(claimToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
            A claim code enrolls one frame. It can be used once and expires in
            24 hours; the frame appears here as <em>pending</em> until you
            confirm it.
          </p>
        </div>
        <div className="inline-actions">
          <button
            className="button button--subtle button--small"
            onClick={() => setOpen(false)}
            type="button"
          >
            Close
          </button>
        </div>
      </div>

      {claimToken ? (
        <div className="card" data-testid="claim-token">
          <p className="copy">
            Claim code (shown once{expiresAt ? `, valid until ${new Date(expiresAt).toLocaleString()}` : ""}):
          </p>
          <p>
            <code style={{ fontSize: "1.1rem", userSelect: "all" }}>
              {claimToken}
            </code>{" "}
            <button
              className="button button--subtle button--small"
              onClick={() => void copyToken()}
              type="button"
            >
              <Copy aria-hidden size={16} />
              {copied ? "Copied" : "Copy"}
            </button>
          </p>
        </div>
      ) : (
        <div className="inline-actions" style={{ margin: "0.5rem 0" }}>
          <input
            className="input"
            maxLength={256}
            onChange={(event) => setName(event.target.value)}
            placeholder="Frame name (optional)"
            value={name}
          />
          <button
            className="button button--small"
            disabled={busy}
            onClick={() => void mintToken()}
            type="button"
          >
            {busy ? "Creating…" : "Create claim code"}
          </button>
          {error ? <span className="pill pill--error">{error}</span> : null}
        </div>
      )}

      <div className="grid" style={{ gap: "0.75rem", marginTop: "0.75rem" }}>
        <div className="card">
          <h4>
            <TerminalSquare aria-hidden size={18} /> Install script (any Pi /
            most Linux)
          </h4>
          <p className="copy">
            Already running Raspberry Pi OS — or Debian/Ubuntu on any Pi or
            other Linux box? One command installs the FrameOS binaries and
            enrolls the frame here (asks a few questions about your display):
          </p>
          <pre className="copy" style={{ overflowX: "auto", userSelect: "all" }}>
            {installCommand}
          </pre>
          <button
            className="button button--subtle button--small"
            onClick={() => void copyText(installCommand, setInstallCopied)}
            type="button"
          >
            <Copy aria-hidden size={16} />
            {installCopied ? "Copied" : "Copy command"}
          </button>
          <p className="copy">
            The claim code is single-use and the script disables any backend
            connection — a frame has exactly one control plane.
          </p>
        </div>
        <div className="card">
          <h4>
            <MonitorSmartphone aria-hidden size={18} /> SD card image
            (Raspberry Pi)
          </h4>
          <p className="copy">
            Download the generic FrameOS image for your board from the{" "}
            <a
              href="https://github.com/FrameOS/frameos/releases/latest"
              rel="noreferrer noopener"
              target="_blank"
            >
              latest release
            </a>
            , flash it, then create a file named{" "}
            <code>frameos-cloud.txt</code> on the SD card&apos;s boot
            partition:
          </p>
          <pre className="copy">
            {`cloud_url=${typeof window !== "undefined" ? window.location.origin : "https://cloud.frameos.net"}
claim_token=${claimToken ?? "<your claim code>"}
# optional:
# name=Kitchen frame
# wifi_ssid=MyNetwork
# wifi_password=…`}
          </pre>
          <p className="copy">
            The file is read once on first boot and destroyed. Without WiFi
            credentials the frame opens the <code>FrameOS-Setup</code> hotspot
            so you can connect it to your network first.
          </p>
        </div>
        <div className="card">
          <h4>
            <QrCode aria-hidden size={18} /> Link an existing frame
          </h4>
          <p className="copy">
            On the frame&apos;s admin page (Settings → FrameOS Cloud), choose
            Connect and approve the code it shows on the{" "}
            <a href="/device">device page</a> — no claim code needed. Or paste
            a claim code into the frame&apos;s setup portal.
          </p>
        </div>
        <Esp32CloudFlasher claimToken={claimToken} />
      </div>
    </div>
  );
}
