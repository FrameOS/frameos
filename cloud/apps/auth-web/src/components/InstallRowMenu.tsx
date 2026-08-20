"use client";

import { MoreHorizontal, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  isReauthRequired,
  redirectToReauthIfRequired,
  takePendingReauthAction,
} from "../lib/reauth-client";

// Per-row "..." menu on the installs table; destructive actions live here
// instead of as always-visible buttons.
export function InstallRowMenu({
  linkedClientId,
  name,
}: {
  linkedClientId: string;
  name: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Fixed-position coordinates: the panel must escape the table's
  // overflow:hidden (used for its rounded corners).
  const [panelPosition, setPanelPosition] = useState({ right: 0, top: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const resumeAction = `revoke-install:${linkedClientId}`;

  // Back from /login/reauth: the revoke was confirmed before the detour, so
  // finish it without reopening the menu or asking again.
  useEffect(() => {
    if (takePendingReauthAction(resumeAction)) {
      void revoke({ resumed: true });
    }
  }, [resumeAction]);

  async function revoke({ resumed = false } = {}) {
    if (
      !resumed &&
      !window.confirm(
        `Revoke the cloud link for "${name}"? The device loses access until it is linked again.`,
      )
    ) {
      return;
    }
    setBusy(true);
    const response = await fetch("/api/device/revoke", {
      body: JSON.stringify({ linked_client_id: linkedClientId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string }
        | undefined;
      // A resumed call that is still refused (Cancel on the reauth page)
      // stops here instead of bouncing back to /login/reauth.
      if (
        !(resumed && isReauthRequired(response, payload)) &&
        redirectToReauthIfRequired(response, payload, resumeAction)
      ) {
        return;
      }
    }
    setBusy(false);
    setOpen(false);
    if (response.ok) {
      router.refresh();
    }
  }

  return (
    <div className="row-menu" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="button button--small"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPanelPosition({
            right: window.innerWidth - rect.right,
            top: rect.bottom + 4,
          });
          setOpen((value) => !value);
        }}
        title="More actions"
        type="button"
      >
        <MoreHorizontal aria-hidden size={16} />
      </button>
      {open ? (
        <div
          className="row-menu__panel"
          role="menu"
          style={{ right: panelPosition.right, top: panelPosition.top }}
        >
          <button
            className="row-menu__item"
            disabled={busy}
            onClick={() => void revoke()}
            role="menuitem"
            type="button"
          >
            <Unplug aria-hidden size={16} />
            {busy ? "Revoking…" : "Revoke link"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
