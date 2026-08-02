import { getRouteBasePath } from './utils/getBasePath'
import { frameAdminPath, isInFrameAdminMode } from './utils/frameAdmin'
import { getFrameControlFrameId } from './utils/frameControlMode'
import type { FrameId } from './utils/frameId'

function frameUrl(id: FrameId, tool?: string): string {
  return getRouteBasePath() + '/frames/' + id + (tool ? `?tool=${encodeURIComponent(tool)}` : '')
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
  scenes: (frameId?: FrameId, sceneId?: string) =>
    getRouteBasePath() + '/scenes' + (frameId ? '/' + frameId : '') + (frameId && sceneId ? '/' + sceneId : ''),
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
