import { getRouteBasePath } from './utils/getBasePath'
import { frameAdminPath, isInFrameAdminMode } from './utils/frameAdmin'
import { getFrameControlFrameId } from './utils/frameControlMode'
import type { FrameId } from './utils/frameId'
import { isCloudMode } from './utils/cloudMode'

// Self-hosted: /frames/<id> and /scenes/<frameId>/<sceneId> beside each
// other under the base path. Cloud: the SPA is mounted AT /frames, so a
// frame is /frames/<id> (not /frames/frames/<id>) and its scenes nest under
// it — /frames/<id>/scenes/<sceneId>. The apps and photos pages are not
// about one frame, so on the cloud they sit beside the mount at the origin
// root — /apps, /apps/system/<keyword>, /apps/frames/<id>/…, /photos — and
// the cloud serves the shell there too (appsUrl below, cloud-frontend/src/
// routes.ts, app/apps and app/photos in auth-web).
//
// A frame tool is a path segment: /frames/<id>/logs. The overview is the
// bare frame path. (`?tool=` is still read by the router for old links.)
function frameUrl(id: FrameId, tool?: string): string {
  const path = isCloudMode() ? getRouteBasePath() + '/' + id : getRouteBasePath() + '/frames/' + id
  if (!tool || tool === 'overview') {
    return path
  }
  // `:tool` is the router pattern (scenes.tsx); encoding it would register
  // `/frames/:id/%3Atool` and no tool route would ever match.
  return path + '/' + (tool.startsWith(':') ? tool : encodeURIComponent(tool))
}

function scenesUrl(frameId?: FrameId, sceneId?: string): string {
  if (isCloudMode() && frameId) {
    return getRouteBasePath() + '/' + frameId + '/scenes' + (sceneId ? '/' + sceneId : '')
  }
  return getRouteBasePath() + '/scenes' + (frameId ? '/' + frameId : '') + (frameId && sceneId ? '/' + sceneId : '')
}

// The global settings page. Self-hosted it is one long page of anchored
// sections (/settings#settings-openai). On the cloud it is a set of pages —
// the account's backends, service keys, SSH keys, usage, backups, activity,
// security and developer pages (scenes/settings/account/accountPages.ts) —
// each at /account/<page>, the address the account pages have always had;
// the bare /account lands on the first. The cloud serves this SPA's shell
// at /account/** as well as at its /frames mount (cloud-frontend/src/routes.ts
// cloudAccountBasePath mirrors the constant), so the rail gear is an in-app
// route on every control plane.
function settingsUrl(page?: string): string {
  if (isInFrameAdminMode()) {
    return frameControlUrl('settings')
  }
  // `:page` is the router pattern (scenes.tsx); encoding it would register
  // `/settings/%3Apage` and the page routes would never match.
  const segment = page ? '/' + (page.startsWith(':') ? page : encodeURIComponent(page)) : ''
  if (isCloudMode()) {
    return '/account' + segment
  }
  return getRouteBasePath() + '/settings' + segment
}

function frameControlUrl(tool?: string): string {
  return frameUrl(getFrameControlFrameId(), tool)
}

function frameControlScenesUrl(sceneId?: string): string {
  return getRouteBasePath() + '/scenes/' + getFrameControlFrameId() + (sceneId ? '/' + sceneId : '')
}

export const urls = {
  /** Cloud only: the account's usage page (quotas, AI usage). */
  accountUsage: () => settingsUrl('usage'),
  frames: () =>
    isInFrameAdminMode() ? getRouteBasePath() + frameAdminPath() : getRouteBasePath() ? getRouteBasePath() : '/',
  frame: frameUrl,
  frameControl: frameControlUrl,
  scenes: scenesUrl,
  frameControlScenes: frameControlScenesUrl,
  /** A frame's apps: /apps/<frameId>/<sceneId>/<nodeId> self-hosted,
   * /apps/frames/<frameId>/… on the cloud (the bare path is the first frame). */
  apps: (frameId?: FrameId, sceneId?: string, nodeId?: string) =>
    (isCloudMode() ? '/apps/frames' : getRouteBasePath() + '/apps') +
    (frameId ? '/' + frameId : '') +
    (frameId && sceneId ? '/' + sceneId : '') +
    (frameId && sceneId && nodeId ? '/' + nodeId : ''),
  /** Where the rail's Apps button lands without a remembered page: the
   * cloud's bare /apps (the system apps), the system apps self-hosted. */
  appsHome: () => (isCloudMode() ? '/apps' : getRouteBasePath() + '/apps/system'),
  // The folder rides in the query (?folder=Summer%2FBeach), not the path, so
  // one route pattern covers every depth.
  photos: (folder?: string | null) =>
    (isCloudMode() ? '/photos' : getRouteBasePath() + '/photos') +
    (folder ? '?' + new URLSearchParams({ folder }).toString() : ''),
  // `:keyword` is the router pattern (scenes.tsx); encoding it would register
  // `/apps/system/%3Akeyword` and the route would never match.
  systemApps: (keyword?: string | null) =>
    (isCloudMode() ? '/apps/system' : getRouteBasePath() + '/apps/system') +
    (keyword ? '/' + (keyword.startsWith(':') ? keyword : encodeURIComponent(keyword)) : ''),
  settings: settingsUrl,
  login: () => getRouteBasePath() + '/login',
  logout: () => getRouteBasePath() + '/logout',
  signup: () => getRouteBasePath() + '/signup',
  setupUnavailable: () => getRouteBasePath() + '/setup-unavailable',
} as const
