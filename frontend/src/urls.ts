import { getBasePath } from './utils/getBasePath'

export const urls = {
  frames: () => (getBasePath() ? getBasePath() : '/'),
  frame: (id: number | string, tool?: string) =>
    getBasePath() + '/frames/' + id + (tool ? `?tool=${encodeURIComponent(tool)}` : ''),
  scenes: (frameId?: number | string, sceneId?: string) =>
    getBasePath() + '/scenes' + (frameId ? '/' + frameId : '') + (frameId && sceneId ? '/' + sceneId : ''),
  apps: (frameId?: number | string, sceneId?: string, nodeId?: string) =>
    getBasePath() +
    '/apps' +
    (frameId ? '/' + frameId : '') +
    (frameId && sceneId ? '/' + sceneId : '') +
    (frameId && sceneId && nodeId ? '/' + nodeId : ''),
  settings: () => getBasePath() + '/settings',
  login: () => getBasePath() + '/login',
  logout: () => getBasePath() + '/logout',
  signup: () => getBasePath() + '/signup',
} as const
