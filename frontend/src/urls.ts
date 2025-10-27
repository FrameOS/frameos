import { getBasePath } from './utils/getBasePath'

export const urls = {
  frames: () => (getBasePath() ? getBasePath() : '/'),
  frame: (id: number | string) => getBasePath() + '/frames/' + id,
  settings: () => getBasePath() + '/settings',
  gallery: () => getBasePath() + '/gallery',
  login: () => getBasePath() + '/login',
  logout: () => getBasePath() + '/logout',
  signup: () => getBasePath() + '/signup',
} as const
