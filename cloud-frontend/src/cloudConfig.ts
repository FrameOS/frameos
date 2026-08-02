// Server-injected facts the SPA cannot work out for itself.
//
// cloud/apps/auth-web/app/frames/[[...path]]/route.ts replaces a named anchor
// line in src/index.html with these keys before serving the shell (the same
// mechanism cloud_ws_origin uses). They exist because the values come from
// server-side configuration:
//
//   * the account/scenes/cloud surfaces can live on three different origins
//     (FRAMEOS_ACCOUNT_APP_URL / FRAMEOS_SCENES_APP_URL / FRAMEOS_CLOUD_APP_URL),
//     and getAccountPath() shortens /account/* on a split-host deployment —
//     none of which a client-only bundle can reconstruct from window.location;
//   * the claim-code TTL is FRAMEOS_CLOUD_CLAIM_TOKEN_TTL_HOURS, so a
//     hardcoded "24 hours" would quietly lie on a tuned install;
//   * cloudOrigin is written into SD images, ESP32 NVS and install commands,
//     so it must be the deployment's real public URL — not whatever host the
//     admin happens to be browsing through (a tunnel, a LAN IP, 127.0.0.1 vs
//     localhost). window.location.origin is only the last-resort fallback for
//     a shell served without injection (a stale public/frames-app copy).

interface CloudAppConfig {
  cloud_account_url?: string
  cloud_claim_token_ttl_hours?: number
  cloud_frames_url?: string
  cloud_logout_url?: string
  cloud_origin?: string
  cloud_scenes_url?: string
  cloud_theme_cookie_domain?: string
}

function config(): CloudAppConfig {
  if (typeof window === 'undefined') {
    return {}
  }
  return ((window as unknown as { FRAMEOS_APP_CONFIG?: CloudAppConfig }).FRAMEOS_APP_CONFIG ?? {}) as CloudAppConfig
}

function browserOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin
}

/** The origin frames enrol against. See the note above before "simplifying". */
export function cloudOrigin(): string {
  return config().cloud_origin || browserOrigin()
}

/** How long a minted claim code stays valid, in hours. */
export function claimTokenTtlHours(): number {
  const value = config().cloud_claim_token_ttl_hours
  return typeof value === 'number' && value > 0 ? value : 24
}

/**
 * Domain for the shared frameos_theme cookie, or '' for a host-only cookie.
 * Empty is correct on a single-origin install (localhost, self-hosted); on a
 * split-host deployment it is the parent domain the account pages use, so both
 * surfaces read and write the same cookie.
 */
export function themeCookieDomain(): string {
  return config().cloud_theme_cookie_domain || ''
}

/** Where the account header's links point. */
export function accountNavUrls(): {
  accountUrl: string
  framesUrl: string
  logoutUrl: string
  scenesUrl: string
} {
  const injected = config()
  const origin = browserOrigin()
  return {
    accountUrl: injected.cloud_account_url || `${origin}/account`,
    framesUrl: injected.cloud_frames_url || `${origin}/frames`,
    logoutUrl: injected.cloud_logout_url || `${origin}/api/auth/logout`,
    scenesUrl: injected.cloud_scenes_url || `${origin}/`,
  }
}
