import { getBasePath } from './getBasePath'

export function assetUrl(path: string): string {
  const basePath = getBasePath()
  if (!basePath || typeof window === 'undefined') {
    return path
  }

  if (path.startsWith('/')) {
    return `${basePath}${path}`
  }

  try {
    return new URL(path, `${window.location.origin}${basePath}/static/`).toString()
  } catch {
    return path
  }
}
