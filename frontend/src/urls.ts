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
  return path + (tool && tool !== 'overview' ? '/' + encodeURIComponent(tool) : '')
}

function scenesUrl(frameId?: FrameId, sceneId?: string): string {
  if (isCloudMode() && frameId) {
    return getRouteBasePath() + '/' + frameId + '/scenes' + (sceneId ? '/' + sceneId : '')
  }
  return getRouteBasePath() + '/scenes' + (frameId ? '/' + frameId : '') + (frameId && sceneId ? '/' + sceneId : '')
}

function frameControlUrl(tool?: string): string {
  return frameUrl(getFrameControlFrameId(), tool)
}

function frameControlScenesUrl(sceneId?: string): string {
  return getRouteBasePath() + '/scenes/' + getFrameControlFrameId() + (sceneId ? '/' + sceneId : '')
}

export const urls = {
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
  systemApps: (keyword?: string | null) =>
    getRouteBasePath() + '/apps/system' + (keyword ? '/' + encodeURIComponent(keyword) : ''),
  settings: () => (isInFrameAdminMode() ? frameControlUrl('settings') : getRouteBasePath() + '/settings'),
  login: () => getRouteBasePath() + '/login',
  logout: () => getRouteBasePath() + '/logout',
  signup: () => getRouteBasePath() + '/signup',
  setupUnavailable: () => getRouteBasePath() + '/setup-unavailable',
} as const
