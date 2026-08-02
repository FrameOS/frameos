import { getAssetsBasePath } from './getBasePath'

export function assetUrl(path: string): string {
  const basePath = getAssetsBasePath()
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
