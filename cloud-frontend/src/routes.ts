// Where the cloud frames SPA lives, in one place.
//
// Two very different consumers need this: the SPA itself (src/main.tsx sets
// route_base_path, and scenes.tsx builds its route table from the shared
// `urls` helper on top of it) and Next.js server components that link INTO
// the SPA (cloud/apps/auth-web/app/account/frames/page.tsx). The Next.js side
// cannot call `urls.frame()` — that reads window.FRAMEOS_APP_CONFIG, which
// does not exist during SSR, so it would silently emit "/frames/<id>" and
// 404 against the SPA's real "/frames/frames/<id>" route.
//
// So: window-free constants here, and a test
// (cloud/apps/auth-web/src/test/cloud-frames-routes.test.ts) asserts these
// agree with what `urls` produces under the SPA's own config. Change one and
// the test fails.

/** SPA mount point. Mirrored in src/index.html for the pre-bundle config. */
export const cloudRouteBasePath = '/frames'

/** Public assets (Next serves cloud-frontend/dist from public/frames-app). */
export const cloudAssetsBasePath = '/frames-app'

/** The frames list — the SPA's home scene. */
export function cloudFramesUrl(): string {
  return cloudRouteBasePath
}

/**
 * A single frame's workspace: /frames/<id>. The shared SPA's `urls.frame()`
 * drops its own "/frames" segment in cloud mode because the route base path
 * is already "/frames" (frontend/src/urls.ts).
 */
export function cloudFrameUrl(frameId: string, tool?: string): string {
  const path = `${cloudRouteBasePath}/${encodeURIComponent(frameId)}`
  return tool ? `${path}?tool=${encodeURIComponent(tool)}` : path
}

/** A scene of a frame: /frames/<frameId>/scenes/<sceneId>. */
export function cloudSceneUrl(frameId: string, sceneId?: string): string {
  const path = `${cloudRouteBasePath}/${encodeURIComponent(frameId)}/scenes`
  return sceneId ? `${path}/${encodeURIComponent(sceneId)}` : path
}

/** The account settings page (service API keys) — the SPA's `settings` scene. */
export function cloudSettingsUrl(): string {
  return `${cloudRouteBasePath}/settings`
}

/**
 * The workspace URLs before August 2026 doubled the segment
 * (/frames/frames/<id>, /frames/scenes/<frameId>/<sceneId>). Old bookmarks and
 * emails still carry them; this maps one to its current shape, or returns
 * null when the path is already current.
 */
export function legacyCloudPathRedirect(pathname: string): string | null {
  const frameMatch = /^\/frames\/frames\/([^/]+)\/?$/.exec(pathname)
  if (frameMatch) {
    return `${cloudRouteBasePath}/${frameMatch[1]}`
  }
  const sceneMatch = /^\/frames\/scenes\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname)
  if (sceneMatch) {
    return `${cloudRouteBasePath}/${sceneMatch[1]}/scenes${sceneMatch[2] ? `/${sceneMatch[2]}` : ''}`
  }
  return null
}
