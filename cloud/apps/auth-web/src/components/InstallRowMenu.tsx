"use client";

import { Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  isReauthRequired,
  redirectToReauthIfRequired,
  takePendingReauthAction,
} from "../lib/reauth-client";
import { RowMenu } from "./RowMenu";

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
  const [busy, setBusy] = useState(false);

  const resumeAction = `revoke-install:${linkedClientId}`;

  // Back from /login/reauth: the revoke was confirmed before the detour, so
  // finish it without reopening the menu or asking again.
  useEffect(() => {
    if (takePendingReauthAction(resumeAction)) {
      void revoke(() => undefined, { resumed: true });
    }
  }, [resumeAction]);

  async function revoke(close: () => void, { resumed = false } = {}) {
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
    close();
    if (response.ok) {
      router.refresh();
    }
  }

  return (
    <RowMenu label={`More actions for ${name}`}>
      {(close) => (
        <button
          className="row-menu__item"
          disabled={busy}
          onClick={() => void revoke(close)}
          role="menuitem"
          type="button"
        >
          <Unplug aria-hidden size={16} />
          {busy ? "Revoking…" : "Revoke link"}
        </button>
      )}
    </RowMenu>
  );
}
