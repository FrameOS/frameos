import { getBasePath } from './utils/getBasePath'
import { frameAdminPath, isInFrameAdminMode } from './utils/frameAdmin'
import { getFrameControlFrameId } from './utils/frameControlMode'

function frameUrl(id: number | string, tool?: string): string {
  return getBasePath() + '/frames/' + id + (tool ? `?tool=${encodeURIComponent(tool)}` : '')
}

function frameControlUrl(tool?: string): string {
  return frameUrl(getFrameControlFrameId(), tool)
}

function frameControlScenesUrl(sceneId?: string): string {
  return getBasePath() + '/scenes/' + getFrameControlFrameId() + (sceneId ? '/' + sceneId : '')
}

export const urls = {
  frames: () => (isInFrameAdminMode() ? getBasePath() + frameAdminPath() : getBasePath() ? getBasePath() : '/'),
  frame: frameUrl,
  frameControl: frameControlUrl,
  scenes: (frameId?: number | string, sceneId?: string) =>
    getBasePath() + '/scenes' + (frameId ? '/' + frameId : '') + (frameId && sceneId ? '/' + sceneId : ''),
  frameControlScenes: frameControlScenesUrl,
  apps: (frameId?: number | string, sceneId?: string, nodeId?: string) =>
    getBasePath() +
    '/apps' +
    (frameId ? '/' + frameId : '') +
    (frameId && sceneId ? '/' + sceneId : '') +
    (frameId && sceneId && nodeId ? '/' + nodeId : ''),
  systemApps: (keyword?: string | null) =>
    getBasePath() + '/apps/system' + (keyword ? '/' + encodeURIComponent(keyword) : ''),
  settings: () => (isInFrameAdminMode() ? frameControlUrl('settings') : getBasePath() + '/settings'),
  login: () => getBasePath() + '/login',
  logout: () => getBasePath() + '/logout',
  signup: () => getBasePath() + '/signup',
  setupUnavailable: () => getBasePath() + '/setup-unavailable',
} as const
