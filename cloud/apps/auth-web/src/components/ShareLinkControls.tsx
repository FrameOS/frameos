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
      setError("Could not copy. Select the link and copy it by hand.");
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
      <p className="share-link__intro">
        {shareUrl
          ? "Anyone with this link can view and install the scene."
          : "Sharing is off: no link works, only you can see the scene."}
      </p>
      {shareUrl ? (
        <div className="share-link__field">
          {/* One line, selected whole on focus: the link is long and only
              ever copied. */}
          <input
            aria-label="Sharing link"
            className="share-link__url"
            data-testid="share-link-url"
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            value={shareUrl}
          />
          <button
            aria-label={copied ? "Copied" : "Copy link"}
            className="button button--small"
            disabled={busy}
            onClick={() => void copyLink()}
            type="button"
          >
            <Copy aria-hidden size={14} />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}
      <div className="share-link__actions">
        {shareUrl ? (
          <>
            <button
              className="share-link__action"
              disabled={busy}
              onClick={confirmRotate}
              title="Mint a new link; the current one stops working"
              type="button"
            >
              <RefreshCw aria-hidden size={12} />
              Replace link
            </button>
            <button
              className="share-link__action"
              disabled={busy}
              onClick={confirmDisable}
              type="button"
            >
              <Link2Off aria-hidden size={12} />
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
            <Link2 aria-hidden size={14} />
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
