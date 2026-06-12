import { getBasePath } from './utils/getBasePath'
import { isFrameControlMode } from './utils/frameControlMode'
import { frameAdminPath } from './utils/frameAdmin'

// In frame control mode (the admin UI served by the frame itself) there is no
// backend: a single frame is the whole world and it lives under /admin. The
// frame overview doubles as the homepage; the scene and app editors keep the
// same path shape as the backend, just mounted under /admin.
const workspaceBasePath = (): string => (isFrameControlMode() ? frameAdminPath() : getBasePath())

export const urls = {
  frames: () => (isFrameControlMode() ? frameAdminPath() : getBasePath() ? getBasePath() : '/'),
  frame: (id: number | string, tool?: string) =>
    isFrameControlMode()
      ? frameAdminPath() + (tool ? `?tool=${encodeURIComponent(tool)}` : '')
      : getBasePath() + '/frames/' + id + (tool ? `?tool=${encodeURIComponent(tool)}` : ''),
  scenes: (frameId?: number | string, sceneId?: string) =>
    workspaceBasePath() + '/scenes' + (frameId ? '/' + frameId : '') + (frameId && sceneId ? '/' + sceneId : ''),
  apps: (frameId?: number | string, sceneId?: string, nodeId?: string) =>
    workspaceBasePath() +
    '/apps' +
    (frameId ? '/' + frameId : '') +
    (frameId && sceneId ? '/' + sceneId : '') +
    (frameId && sceneId && nodeId ? '/' + nodeId : ''),
  systemApps: (keyword?: string | null) =>
    workspaceBasePath() + '/apps/system' + (keyword ? '/' + encodeURIComponent(keyword) : ''),
  settings: () => (isFrameControlMode() ? frameAdminPath() + '?tool=settings' : getBasePath() + '/settings'),
  login: () => getBasePath() + '/login',
  logout: () => getBasePath() + '/logout',
  signup: () => getBasePath() + '/signup',
  setupUnavailable: () => getBasePath() + '/setup-unavailable',
} as const
