"use client";

import { Copy, Link2, Link2Off, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ownerActionErrorMessage } from "./ownerActionError";

type ShareLinkControlsProps = {
  sceneId: string;
  /** The sharing link, token included — null while sharing is turned off. */
  shareUrl: string | null;
};

// The owner's handle on a private scene's sharing link: copy it, replace it
// (the old link dies — the fix for a link that leaked), or turn it off. The
// route (`PATCH /api/account/scenes/{id}` with `share: "rotate" | "disable"`)
// existed for a while with nothing calling it; the link itself was shown
// and nothing else.
export function ShareLinkControls({ sceneId, shareUrl }: ShareLinkControlsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function change(share: "rotate" | "disable"): Promise<void> {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch(`/api/account/scenes/${sceneId}`, {
        body: JSON.stringify({ share }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      if (response.ok) {
        // The page builds every link from the token server-side.
        router.refresh();
      } else {
        let detail: Record<string, unknown> = {};
        try {
          detail = (await response.json()) as Record<string, unknown>;
        } catch {
          // no JSON body; the status carries the message
        }
        setError(ownerActionErrorMessage(detail, response.status));
      }
    } catch (fetchError) {
      setError(
        `Failed (${fetchError instanceof Error ? fetchError.message : String(fetchError)})`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(): Promise<void> {
    if (!shareUrl) {
      return;
    }
    setError(null);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      setError("Could not copy — select the link and copy it by hand");
    }
  }

  function confirmRotate(): void {
    if (
      window.confirm(
        "Replace the sharing link? Anyone holding the current link loses access; your frames keep working.",
      )
    ) {
      void change("rotate");
    }
  }

  function confirmDisable(): void {
    if (
      window.confirm(
        "Turn sharing off? The link stops working for everyone until you turn it back on.",
      )
    ) {
      void change("disable");
    }
  }

  return (
    <div className="share-link" data-testid="share-link-controls">
      {shareUrl ? (
        <code className="share-link__url" data-testid="share-link-url">
          {shareUrl}
        </code>
      ) : (
        <span className="share-link__url">Sharing is off — no link works right now.</span>
      )}
      <div className="inline-actions">
        {shareUrl ? (
          <>
            <button
              className="button button--small"
              disabled={busy}
              onClick={() => void copyLink()}
              type="button"
            >
              <Copy aria-hidden size={16} />
              {copied ? "Copied" : "Copy link"}
            </button>
            <button
              className="button button--small"
              disabled={busy}
              onClick={confirmRotate}
              title="Mint a new link; the current one stops working"
              type="button"
            >
              <RefreshCw aria-hidden size={16} />
              Replace link
            </button>
            <button
              className="button button--small"
              disabled={busy}
              onClick={confirmDisable}
              type="button"
            >
              <Link2Off aria-hidden size={16} />
              Turn sharing off
            </button>
          </>
        ) : (
          <button
            className="button button--small"
            disabled={busy}
            onClick={() => void change("rotate")}
            type="button"
          >
            <Link2 aria-hidden size={16} />
            Turn sharing on
          </button>
        )}
        {error ? (
          <span className="pill pill-warning" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
