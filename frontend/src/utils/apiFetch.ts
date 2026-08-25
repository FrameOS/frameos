import { router } from 'kea-router'
import { inHassioIngress } from './inHassioIngress'
import { getBasePath } from './getBasePath'
import { urls } from '../urls'
import { isFrameControlMode } from './frameControlMode'
import { isInFrameAdminMode } from './frameAdmin'
import { isCloudMode } from './cloudMode'
import { clearCachedProjectId, projectApiPath } from './projectApi'

export interface ApiFetchOptions extends RequestInit {}

// The standalone embedded editor has no backend at all: apiFetch answers
// every call with a synthetic 404 (see below), so a catalog loader falling
// back to its default there is the expected outcome, not a failure. Five of
// them mount on every scene-store page load, and console.error would report
// each one as a real error (Next.js dev even counts them as page "issues").
// Loaders whose catch swallows the error and returns a fallback log through
// this instead.
export function logApiError(...args: unknown[]): void {
  if (typeof window !== 'undefined' && (window as any).FRAMEOS_EMBEDDED_NO_BACKEND) {
    console.debug(...args)
    return
  }
  console.error(...args)
}

export type FirstUserStatus = 'exists' | 'missing' | 'unknown'

export async function firstUserStatus(): Promise<FirstUserStatus> {
  if (isFrameControlMode()) {
    return 'missing'
  }
  if (isCloudMode()) {
    // The cloud has no /api/has_first_user; its Next.js auth pages own
    // signup, so the SPA's own signup flow must never engage.
    return 'exists'
  }
  try {
    const resp = await fetch(`${getBasePath()}/api/has_first_user`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    if (!resp.ok) {
      return 'unknown'
    }
    const json = await resp.json()
    if (json.has_first_user === true) {
      return 'exists'
    }
    if (json.has_first_user === false) {
      return 'missing'
    }
    return 'unknown'
  } catch (error) {
    console.error('Error checking if user exists:', error)
    return 'unknown'
  }
}

export async function userExists(): Promise<boolean> {
  return (await firstUserStatus()) === 'exists'
}

function routeToAuthStatus(status: FirstUserStatus): Promise<never> {
  // replace, not push: an auth-guard redirect must not add a history entry —
  // otherwise Back loops through the redirect forever (worst when the app is
  // embedded in an iframe, where it also pollutes the parent's history).
  router.actions.replace(
    status === 'exists' ? urls.login() : status === 'missing' ? urls.signup() : urls.setupUnavailable()
  )
  return new Promise(() => {})
}

// Catalogs owned by a self-hosted backend. The cloud serves /api/frames/**
// and /api/settings, so in cloud mode these are guaranteed 404s: failed
// requests and console errors on every page load, purely to reach fallbacks
// the callers already have (the embedded app catalog, an empty font list).
// Answer them locally with the empty shape each loader expects instead.
//
// GET only: a POST to /api/templates imports a template, and pretending that
// succeeded would silently swallow the import. Exact paths only, so
// /api/templates/{id}/image still goes to the network and fails honestly.
//
// If the cloud ever grows one of these for real, delete its line — leaving it
// here would mask the new endpoint. (/api/settings lived here until the cloud
// grew account settings — app/api/settings/route.ts; /api/fonts until it grew
// the font catalogue — app/api/fonts/route.ts, which is also what made the
// scene editor's font picker work there.)
const cloudEmptyCatalogs: Record<string, string> = {
  '/api/apps': '{"apps":{}}',
  // The workspace's uploaded-asset catalog (settingsLogic loadCustomFonts
  // filters it for fonts/*.ttf) — backend file storage the cloud lacks.
  '/api/assets': '[]',
  // The backend's own cloud-link status (types.tsx CloudStatus). Inside the
  // cloud there is no link to report on, so answer with the permanent
  // "this install has no cloud features" shape cloudLogic renders as-is.
  '/api/cloud/status':
    '{"enabled":false,"provider_url":null,"default_provider_url":null,"status":"disconnected",' +
    '"can_edit_provider":false,"poll_error":null,"connection":null,"link":null}',
  '/api/templates': '[]',
}

function emptyCloudCatalog(path: string, method?: string): string | undefined {
  if (method && method.toUpperCase() !== 'GET') {
    return undefined
  }
  return cloudEmptyCatalogs[path.split('?')[0] ?? path]
}

export async function apiFetch(input: RequestInfo | URL, options: ApiFetchOptions = {}): Promise<Response> {
  // The standalone embedded editor (editor.html sets the flag) has no
  // backend: answer every API call with a synthetic 404 so the callers'
  // fallbacks (embedded app catalog, fonts, validation) engage immediately
  // instead of resolving project ids or redirecting to auth screens.
  if (typeof window !== 'undefined' && (window as any).FRAMEOS_EMBEDDED_NO_BACKEND) {
    return new Response('null', { status: 404, statusText: 'No backend in the embedded editor' })
  }
  const frameControlMode = isFrameControlMode()
  const inFrameAdminMode = isInFrameAdminMode()
  const cloudMode = isCloudMode()
  const headers: HeadersInit = options.headers || {}

  if (cloudMode && typeof input === 'string') {
    const empty = emptyCloudCatalog(input, options.method)
    if (empty) {
      return new Response(empty, { headers: { 'Content-Type': 'application/json' }, status: 200 })
    }
  }

  if (typeof input === 'string') {
    // Cloud mode: paths are already canonical (/api/frames/...) at the
    // account origin — no project scoping. Frame-control mode: the local
    // frame serves unscoped /api paths directly.
    if (!frameControlMode && !cloudMode) {
      try {
        input = await projectApiPath(input)
      } catch (error) {
        if (!inHassioIngress()) {
          clearCachedProjectId()
          return routeToAuthStatus(await firstUserStatus())
        }
        throw error
      }
    }
    if (getBasePath() && input.startsWith('/')) {
      input = getBasePath() + input
    }
  }

  const response = await fetch(input, { ...options, headers, credentials: options.credentials || 'include' })

  if (!inHassioIngress() && response.status === 401) {
    if (cloudMode) {
      // Next.js owns auth on the cloud: hand over to its login page and
      // come back to where we were. Never resolve — mirrors the
      // frame-admin redirect below.
      window.location.href = '/login?return_to=' + encodeURIComponent(window.location.pathname)
      return new Promise(() => {})
    }

    if (frameControlMode && inFrameAdminMode) {
      window.location.replace('/login')
      return new Promise(() => {})
    }

    if (!frameControlMode) {
      const status = await firstUserStatus()
      clearCachedProjectId()
      return routeToAuthStatus(status)
    }
  }

  return response
}
