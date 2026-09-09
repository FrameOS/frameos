"use client";

import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import {
  redirectToReauthIfRequired,
  takePendingReauthAction,
} from "../lib/reauth-client";

const resumeAction = "sessions:revoke-all";

// "Sign out everywhere else": every other browser and device holding a
// session on this account is signed out; this one stays. The route is behind
// sudo mode, so a stale session bounces through /login/reauth and the action
// replays on return (the user already pressed the button once).
export function SignOutEverywhereForm() {
  const [state, setState] = useState<"idle" | "submitting" | "done">("idle");
  const [revoked, setRevoked] = useState(0);
  const [error, setError] = useState<string | undefined>();

  async function revokeAll() {
    setState("submitting");
    setError(undefined);
    try {
      const response = await fetch("/api/account/sessions/revoke-all", {
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string; revoked?: number }
        | undefined;
      if (response.ok) {
        setRevoked(typeof payload?.revoked === "number" ? payload.revoked : 0);
        setState("done");
        return;
      }
      if (redirectToReauthIfRequired(response, payload, resumeAction)) {
        return;
      }
      if (response.status === 429) {
        setError("Too many attempts. Wait a few minutes and try again.");
      } else {
        setError("Could not sign out the other sessions. Try again in a moment.");
      }
    } catch {
      setError("Could not sign out the other sessions. Try again in a moment.");
    }
    setState("idle");
  }

  // Back from /login/reauth: the user already pressed the button before the
  // detour, so finish it without asking again.
  useEffect(() => {
    if (takePendingReauthAction(resumeAction)) {
      void revokeAll();
    }
  }, []);

  return (
    <div className="auth-form">
      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {state === "done" ? (
        <p className="copy" role="status">
          {revoked === 0
            ? "No other sessions were signed in."
            : `Signed out ${revoked} other session${revoked === 1 ? "" : "s"}. This one stays.`}
        </p>
      ) : null}
      <div className="actions">
        <button
          className="button"
          disabled={state === "submitting"}
          onClick={() => void revokeAll()}
          type="button"
        >
          <LogOut aria-hidden size={18} />
          {state === "submitting" ? "Signing out…" : "Sign out everywhere else"}
        </button>
      </div>
    </div>
  );
}
