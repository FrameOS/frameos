import { getBasePath } from './utils/getBasePath'

export const urls = {
  frames: () => (getBasePath() ? getBasePath() : '/'),
  frame: (id: number | string) => getBasePath() + '/frames/' + id,
  scenes: (frameId?: number | string, sceneId?: string) =>
    getBasePath() + '/scenes' + (frameId ? '/' + frameId : '') + (frameId && sceneId ? '/' + sceneId : ''),
  settings: () => getBasePath() + '/settings',
  login: () => getBasePath() + '/login',
  logout: () => getBasePath() + '/logout',
  signup: () => getBasePath() + '/signup',
} as const
