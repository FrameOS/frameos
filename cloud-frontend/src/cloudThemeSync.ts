// One theme preference across two apps.
//
// /frames is this SPA; /account/* is the Next app. They are separate bundles
// with separate theme state: the workspace keeps it in
// localStorage['frameos.workspaceTheme'] and styles `.frameos-theme-dark`,
// while the account pages keep it in the `frameos_theme` cookie (plus
// localStorage['frameos-cloud-theme']) and style `.theme-dark`. Neither read
// the other, so toggling on one surface and navigating to the other flipped
// the theme back — the two are one product to the person using them.
//
// The cookie is the shared carrier, because the account pages already read it
// FIRST (ahead of their own localStorage) and because the server reads it to
// render the right theme without a flash. So: seed from it before kea builds
// its initial state, and write it back whenever the workspace theme changes.
//
// All of this lives here rather than in frontend/src/scenes/auth/authThemeLogic
// because that module is shared with the self-hosted backend and the on-device
// admin, which have no account pages to agree with — and because writing the
// cookie needs the Domain the server injects, which shared code cannot see.

import { themeCookieDomain } from './cloudConfig'

type Theme = 'light' | 'dark'

// Must match ThemeToggle.tsx in cloud/apps/auth-web/src/components.
const cookieName = 'frameos_theme'
const accountStorageKey = 'frameos-cloud-theme'
// Must match authThemeLogic's key in frontend/src/scenes/auth.
const workspaceStorageKey = 'frameos.workspaceTheme'

function readThemeCookie(): Theme | undefined {
  if (typeof document === 'undefined') {
    return undefined
  }
  const value = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1)
  return value === 'dark' || value === 'light' ? value : undefined
}

/**
 * Publish a theme to the surfaces outside this bundle. Exported for tests: the
 * subscription below needs a kea store, which the account app's test runner
 * cannot resolve, but the cookie attributes are where the real mistakes live.
 */
export function writeSharedTheme(theme: Theme): void {
  const domain = themeCookieDomain()
  document.cookie = [
    `${cookieName}=${theme}`,
    'Path=/',
    'Max-Age=31536000',
    'SameSite=Lax',
    // Secure only alongside Domain, matching the account pages: a Secure
    // cookie would be dropped on http://localhost during development.
    ...(domain ? [`Domain=${domain}`, 'Secure'] : []),
  ].join('; ')
  // Keep the account app's own key in step too, so it agrees even if the
  // cookie is later cleared while localStorage survives.
  try {
    window.localStorage.setItem(accountStorageKey, theme)
  } catch {
    // Storage can be blocked; the cookie is the one that matters.
  }
}

/**
 * Adopt the shared cookie as the workspace's starting theme.
 *
 * Call BEFORE initKea: authThemeLogic reads localStorage once, when its
 * reducer's default is evaluated, so seeding afterwards would be ignored until
 * a reload.
 */
export function seedThemeFromSharedCookie(): void {
  if (typeof window === 'undefined') {
    return
  }
  const shared = readThemeCookie()
  if (shared) {
    try {
      window.localStorage.setItem(workspaceStorageKey, shared)
    } catch {
      // Nothing to do: authThemeLogic falls back to prefers-color-scheme.
    }
  }
}

/**
 * Publish workspace theme changes to the shared cookie.
 *
 * Watches the attribute applyFrameosTheme sets on <html> rather than
 * subscribing to authThemeLogic. Two reasons: importing that logic pulls
 * kea — and the shared bundle's generated logic types — into the account
 * app's stricter typecheck, which rejects them; and the attribute is the
 * effect itself, so this catches a theme change whatever caused it.
 */
export function syncThemeToSharedCookie(): void {
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') {
    return
  }
  const root = document.documentElement
  let lastTheme = readThemeCookie()
  const publish = (): void => {
    const theme = root.dataset.frameosTheme
    if ((theme !== 'dark' && theme !== 'light') || theme === lastTheme) {
      return
    }
    lastTheme = theme
    writeSharedTheme(theme)
  }
  new MutationObserver(publish).observe(root, {
    attributeFilter: ['data-frameos-theme'],
  })
  // The workspace applies its theme on mount, which may already have happened.
  publish()
}
