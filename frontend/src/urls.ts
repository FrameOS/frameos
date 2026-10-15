import { getRouteBasePath } from './utils/getBasePath'
import { frameAdminPath, isInFrameAdminMode } from './utils/frameAdmin'
import { getFrameControlFrameId } from './utils/frameControlMode'
import type { FrameId } from './utils/frameId'
import { isCloudMode } from './utils/cloudMode'

// Self-hosted: /frames/<id> and /scenes/<frameId>/<sceneId> beside each
// other under the base path. Cloud: the SPA is mounted AT /frames, so a
// frame is /frames/<id> (not /frames/frames/<id>) and its scenes nest under
// it — /frames/<id>/scenes/<sceneId>. Apps keep /frames/apps/... on both.
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
// each at /frames/settings/<page>; the bare /frames/settings lands on the
// first. Both live under the SPA's own mount, so the rail gear is an
// in-app route on every control plane.
function settingsUrl(page?: string): string {
  if (isInFrameAdminMode()) {
    return frameControlUrl('settings')
  }
  // `:page` is the router pattern (scenes.tsx); encoding it would register
  // `/settings/%3Apage` and the page routes would never match.
  const segment = page ? '/' + (page.startsWith(':') ? page : encodeURIComponent(page)) : ''
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
  apps: (frameId?: FrameId, sceneId?: string, nodeId?: string) =>
    getRouteBasePath() +
    '/apps' +
    (frameId ? '/' + frameId : '') +
    (frameId && sceneId ? '/' + sceneId : '') +
    (frameId && sceneId && nodeId ? '/' + nodeId : ''),
  // The folder rides in the query (?folder=Summer%2FBeach), not the path, so
  // one route pattern covers every depth.
  photos: (folder?: string | null) =>
    getRouteBasePath() + '/photos' + (folder ? '?' + new URLSearchParams({ folder }).toString() : ''),
  systemApps: (keyword?: string | null) =>
    getRouteBasePath() + '/apps/system' + (keyword ? '/' + encodeURIComponent(keyword) : ''),
  settings: settingsUrl,
  login: () => getRouteBasePath() + '/login',
  logout: () => getRouteBasePath() + '/logout',
  signup: () => getRouteBasePath() + '/signup',
  setupUnavailable: () => getRouteBasePath() + '/setup-unavailable',
} as const
