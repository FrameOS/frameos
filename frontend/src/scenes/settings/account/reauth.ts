// Re-authentication ("sudo mode") on the cloud, browser side. A sensitive
// route (revoking a link, minting an API token, signing out the other
// sessions, deleting the account) answers 403 `reauth_required` when the
// session last proved its credentials too long ago; the browser then goes to
// the cloud's /login/reauth page and comes back to this one. The server side
// is cloud/apps/auth-web/src/lib/recent-auth.ts.
//
// The page lives on the auth origin, which the shell injects
// (cloud_reauth_url, app/frames/[[...path]]/route.ts); the fallback is only
// for a shell served without injection.

export const reauthRequiredError = 'reauth_required'

const pendingActionKey = 'frameos.reauth.pending'
// Long enough for a passkey prompt or a Google round-trip, short enough that
// a stale tab does not fire a forgotten revoke hours later.
const pendingActionTtlMs = 10 * 60 * 1000

export function isReauthRequired(response: Response, payload: { error?: unknown } | undefined): boolean {
  return response.status === 403 && payload?.error === reauthRequiredError
}

function injectedReauthUrl(): string {
  const injected = typeof window !== 'undefined' ? (window as any).FRAMEOS_APP_CONFIG?.cloud_reauth_url : undefined
  return typeof injected === 'string' && injected ? injected : '/login/reauth'
}

export function reauthHref(returnTo?: string): string {
  const target = returnTo ?? (typeof window !== 'undefined' ? window.location.href : '')
  const url = new URL(
    injectedReauthUrl(),
    typeof window !== 'undefined' ? window.location.href : 'http://frameos.local'
  )
  url.searchParams.set('return_to', target)
  return url.toString()
}

// Returns true when the browser is on its way to /login/reauth; the caller
// should stop and not show an error. Pass `resumeAction` (a string that
// identifies the exact action, e.g. "revoke-install:<id>") and the page can
// replay it on return via takePendingReauthAction — the user already
// confirmed it once and should not have to find the button again.
export function redirectToReauthIfRequired(
  response: Response,
  payload: { error?: unknown } | undefined,
  resumeAction?: string
): boolean {
  if (!isReauthRequired(response, payload)) {
    return false
  }
  if (resumeAction) {
    try {
      window.sessionStorage.setItem(pendingActionKey, JSON.stringify({ action: resumeAction, at: Date.now() }))
    } catch {
      // Storage blocked: the user repeats the action by hand, as before.
    }
  }
  window.location.assign(reauthHref())
  return true
}

// One-shot: true if `action` was stashed by redirectToReauthIfRequired less
// than ten minutes ago. Clears the stash either way, so a replay that fails
// (the user pressed Cancel on the reauth page and still has a stale session)
// is not retried on the next visit.
export function takePendingReauthAction(action: string): boolean {
  return takePendingReauthActionWhere((pending) => pending === action) !== null
}

/** The stashed action when `matches` accepts it, else null. Clears the stash either way. */
export function takePendingReauthActionWhere(matches: (action: string) => boolean): string | null {
  try {
    const raw = window.sessionStorage.getItem(pendingActionKey)
    if (!raw) {
      return null
    }
    window.sessionStorage.removeItem(pendingActionKey)
    const parsed = JSON.parse(raw) as { action?: unknown; at?: unknown }
    if (
      typeof parsed.action === 'string' &&
      typeof parsed.at === 'number' &&
      Date.now() - parsed.at < pendingActionTtlMs &&
      matches(parsed.action)
    ) {
      return parsed.action
    }
    return null
  } catch {
    return null
  }
}
