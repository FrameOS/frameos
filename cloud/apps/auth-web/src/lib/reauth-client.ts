// Browser-side half of re-authentication: when a sensitive route answers 403
// reauth_required, send the user to /login/reauth and back to this page. No
// server imports — this is bundled into client components.

export const reauthRequiredError = "reauth_required";

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
// should stop and not show an error.
export function redirectToReauthIfRequired(
  response: Response,
  payload: { error?: string } | undefined,
) {
  if (!isReauthRequired(response, payload)) {
    return false;
  }
  window.location.assign(reauthHref());
  return true;
}
