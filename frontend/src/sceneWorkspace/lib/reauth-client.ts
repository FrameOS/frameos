// Browser-side half of re-authentication: when a sensitive route answers 403
// reauth_required, send the user to /login/reauth and back to this page. No
// server imports — this is bundled into client components.

export const reauthRequiredError = "reauth_required";

const pendingActionKey = "frameos.reauth.pending";
// Long enough for a passkey prompt or a Google round-trip, short enough that
// a stale tab does not fire a forgotten revoke hours later.
const pendingActionTtlMs = 10 * 60 * 1000;

export function isReauthRequired(
  response: Response,
  payload: { error?: string } | undefined,
) {
  return response.status === 403 && payload?.error === reauthRequiredError;
}

export function reauthHref(returnTo = window.location.href) {
  return `/login/reauth?return_to=${encodeURIComponent(returnTo)}`;
}

// Returns true when the browser is on its way to /login/reauth; the caller
// should stop and not show an error. Pass `resumeAction` (a string that
// identifies the exact action, e.g. "revoke-frame:<id>") and the component
// can replay it on return via takePendingReauthAction — the user already
// confirmed it once and should not have to find the button again.
export function redirectToReauthIfRequired(
  response: Response,
  payload: { error?: string } | undefined,
  resumeAction?: string,
) {
  if (!isReauthRequired(response, payload)) {
    return false;
  }
  if (resumeAction) {
    try {
      window.sessionStorage.setItem(
        pendingActionKey,
        JSON.stringify({ action: resumeAction, at: Date.now() }),
      );
    } catch {
      // Storage blocked: the user repeats the action by hand, as before.
    }
  }
  window.location.assign(reauthHref());
  return true;
}

// One-shot: true if `action` was stashed by redirectToReauthIfRequired less
// than ten minutes ago. Clears the stash either way, so a replay that fails
// (the user pressed Cancel on the reauth page and still has a stale session)
// is not retried on the next visit.
export function takePendingReauthAction(action: string) {
  try {
    const raw = window.sessionStorage.getItem(pendingActionKey);
    if (!raw) {
      return false;
    }
    window.sessionStorage.removeItem(pendingActionKey);
    const parsed = JSON.parse(raw) as { action?: unknown; at?: unknown };
    return (
      parsed.action === action &&
      typeof parsed.at === "number" &&
      Date.now() - parsed.at < pendingActionTtlMs
    );
  } catch {
    return false;
  }
}
