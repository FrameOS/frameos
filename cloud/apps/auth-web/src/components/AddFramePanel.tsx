"use client";

import {
  Copy,
  MonitorSmartphone,
  Plus,
  QrCode,
  TerminalSquare,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Esp32CloudFlasher } from "./Esp32CloudFlasher";
import { SdImageBuilder } from "./SdImageBuilder";

// The panel's open state lives in the URL (?add=frame) rather than in React
// state, so Back/Forward move in and out of it and a shared or reloaded link
// lands where the user expects.
const openParam = "add";
const openValue = "frame";

// Known error codes from POST /api/frames/claim-tokens. "Could not prepare the
// enrollment" plus a raw code told the user nothing, and the old hint ("check
// whether you hit the frame limit") was actively wrong for a claim-code quota.
//
// Unused single-use codes are recycled automatically at the cap, so reaching
// this one means the cap is full of multi-use SD-image codes — which are held
// deliberately, because a flashed card may still be waiting to enrol.
const mintErrorMessages: Record<string, string> = {
  claim_token_quota_exceeded:
    "Every outstanding claim code belongs to an SD-card image, so none can be recycled. Enrol or expire one of those images before adding another frame.",
  frame_quota_exceeded:
    "You have reached your frame limit — remove a frame before adding another.",
  login_required: "Your session expired. Sign in again to add a frame.",
};

// "Add frame": four enrollment paths (install script, SD image, link code,
// ESP32 USB flashing). Claim codes are plumbing, not UX, but they are also a
// capped resource (see maxClaimTokensPerAccount) that nothing can revoke once
// minted — so nothing is minted until the user actually asks for a command.
// Opening and closing the panel, or paging through it with Back/Forward,
// costs zero codes; the SD builder and the ESP32 flasher likewise mint their
// own on first use. The server stores only hashes; every enrolled frame
// appears as pending until the owner confirms it.
interface AddFramePanelProps {
  // Passed in from the server page: the TTL is deployment-configurable
  // (FRAMEOS_CLOUD_CLAIM_TOKEN_TTL_HOURS), and this is a client component, so
  // hardcoding 24 here would quietly lie on any tuned install.
  claimTokenTtlHours: number;
  // The origin frames enrol against. Comes from the server (getAccountBaseUrl)
  // rather than window.location, for two reasons: reading window during render
  // makes SSR and the client disagree (hydration error), and this value is
  // baked into SD images, ESP32 NVS and install commands — it has to be the
  // deployment's real public URL, not whatever host the admin happens to be
  // browsing through (a tunnel, a LAN IP, 127.0.0.1 vs localhost).
  cloudOrigin: string;
}

export function AddFramePanel({
  claimTokenTtlHours,
  cloudOrigin,
}: AddFramePanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const open = searchParams.get(openParam) === openValue;
  const [name, setName] = useState("");
  const [claimToken, setClaimToken] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [installCopied, setInstallCopied] = useState(false);
  // Multi-use token for the SD image builder: one personalized image can be
  // flashed to many cards, each boot enrolling a distinct frame. Minted once
  // per panel session, on the first build.
  const [multiUseToken, setMultiUseToken] = useState<string | undefined>();
  const [multiUseExpiresAt, setMultiUseExpiresAt] = useState<
    string | undefined
  >();
  const [minting, setMinting] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const cancelledRef = useRef(false);

  const origin = cloudOrigin;
  // No FRAMEOS_CLOUD_URL: /install.sh is served with this provider's origin
  // already stamped in (app/install.sh/route.ts), so the URL appears once and
  // the two copies can never disagree.
  const installCommandFor = (token: string) =>
    `curl -fsSL ${origin}/install.sh | sudo FRAMEOS_CLAIM_TOKEN=${token} sh`;
  const installCommand = claimToken ? installCommandFor(claimToken) : undefined;
  // Shown before a code exists, so the command is not a mystery: same shape,
  // with the code itself masked until it is minted.
  const maskedInstallCommand = installCommandFor("<claim code>");

  function setOpen(next: boolean) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) {
      params.set(openParam, openValue);
    } else {
      params.delete(openParam);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  // Closing the panel discards the single-use code — an install may already
  // have spent it — and cancels a mint still in flight, so a slow response
  // can never land on top of a newer token.
  useEffect(() => {
    if (!open) {
      return;
    }
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      abortRef.current?.abort();
      abortRef.current = undefined;
      setClaimToken(undefined);
      setError(undefined);
      setInstallCopied(false);
    };
  }, [open]);

  // Minted on demand, when the user asks for the install command. Nothing is
  // revocable once minted, so an unused code sits against the account's quota
  // until it expires.
  async function generateInstallCommand() {
    if (claimToken || minting) {
      return;
    }
    setMinting(true);
    setError(undefined);
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/frames/claim-tokens", {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      const data = (await response.json().catch(() => ({}))) as {
        claim_token?: string;
        error?: string;
      };
      if (controller.signal.aborted || cancelledRef.current) {
        return;
      }
      if (!response.ok || !data.claim_token) {
        setError(data.error ?? "claim_token_failed");
        return;
      }
      setClaimToken(data.claim_token);
    } catch {
      if (!controller.signal.aborted && !cancelledRef.current) {
        setError("network_error");
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = undefined;
      }
      setMinting(false);
    }
  }

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
            aria-label="Frame name (optional)"
            className="input"
            maxLength={256}
            onChange={(event) => setName(event.target.value)}
            placeholder="Frame name (optional)"
            value={name}
          />
          <button
            className="button button--subtle button--small"
            onClick={() => setOpen(false)}
            type="button"
          >
            Close
          </button>
        </div>
      </div>
      {error ? (
        <p className="copy" role="alert" style={{ color: "var(--warning)" }}>
          {mintErrorMessages[error] ??
            `Could not prepare the enrollment (${error}) — try again in a moment.`}
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
            {installCommand ?? maskedInstallCommand}
          </pre>
          {installCommand ? (
            <button
              className="button button--subtle button--small"
              onClick={() => void copyText(installCommand, setInstallCopied)}
              type="button"
            >
              <Copy aria-hidden size={16} />
              {installCopied ? "Copied" : "Copy command"}
            </button>
          ) : (
            <>
              <button
                className="button button--subtle button--small"
                disabled={minting}
                onClick={() => void generateInstallCommand()}
                type="button"
              >
                <TerminalSquare aria-hidden size={16} />
                {minting ? "Creating a claim code…" : "Generate command"}
              </button>
              <p className="copy">
                Generating fills in a single-use claim code. Codes expire
                within {claimTokenTtlHours} hours, so we create one only when
                you ask.
              </p>
            </>
          )}
        </div>
        <div className="card">
          <h4>
            <MonitorSmartphone aria-hidden size={18} /> SD card image
            (Raspberry Pi)
          </h4>
          <SdImageBuilder
            claimToken={multiUseToken}
            claimTokenExpiresAt={multiUseExpiresAt}
            cloudOrigin={cloudOrigin}
            mintClaimToken={mintClaimToken}
          />
        </div>
        <div className="card">
          <h4>
            <QrCode aria-hidden size={18} /> Link a frame that already runs
          </h4>
          <p className="copy">
            Already have FrameOS running and on your network? Open its admin
            page (Settings → FrameOS Cloud → Connect). The frame shows a short
            code; type it on the <a href="/device">device page</a> to approve
            it.
          </p>
          <p className="copy">
            The frame asks and you approve — nothing to copy from here, and
            the code proves you can see the device.
          </p>
        </div>
        <Esp32CloudFlasher
          cloudOrigin={cloudOrigin}
          frameName={name || undefined}
        />
      </div>
    </div>
  );
}
