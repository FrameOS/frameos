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
 * A single frame's workspace. Note the doubled segment: the shared SPA's
 * `urls.frame()` is `${routeBasePath}/frames/${id}`, and the route base path
 * is itself "/frames".
 */
export function cloudFrameUrl(frameId: string, tool?: string): string {
  const path = `${cloudRouteBasePath}/frames/${encodeURIComponent(frameId)}`
  return tool ? `${path}?tool=${encodeURIComponent(tool)}` : path
}
