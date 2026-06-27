import { getBasePath } from './getBasePath'
import { isInFrameAdminMode } from './frameAdmin'

const frameAdminLogoSvgByPath: Record<string, string> = {
  '/img/logo-2/logo.svg':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#111418" d="M8 6h48v8H16v34H8z"/><path fill="#111418" d="M48 16h8v42H22v-8h26z"/><rect x="18" y="42" width="12" height="12" rx="2" fill="#1c7c66"/><rect x="32" y="30" width="12" height="12" rx="2" fill="#8baa3a"/><rect x="46" y="18" width="12" height="12" rx="2" fill="#c8a247"/></svg>',
  '/img/logo-2/logo-white.svg':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#fff" d="M8 6h48v8H16v34H8z"/><path fill="#fff" d="M48 16h8v42H22v-8h26z"/></svg>',
  '/img/logo-2/logo-black.svg':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#000" d="M8 6h48v8H16v34H8z"/><path fill="#000" d="M48 16h8v42H22v-8h26z"/></svg>',
  '/img/logo-2/logo-white-colors.svg':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#fff" d="M8 6h48v8H16v34H8z"/><path fill="#fff" d="M48 16h8v42H22v-8h26z"/><rect x="18" y="42" width="12" height="12" rx="2" fill="#1c7c66"/><rect x="32" y="30" width="12" height="12" rx="2" fill="#8baa3a"/><rect x="46" y="18" width="12" height="12" rx="2" fill="#c8a247"/></svg>',
}

function frameAdminLogoUrl(path: string): string | null {
  if (!isInFrameAdminMode()) {
    return null
  }

  const svg = frameAdminLogoSvgByPath[path]
  return svg ? `data:image/svg+xml,${encodeURIComponent(svg)}` : null
}

export function assetUrl(path: string): string {
  const frameAdminUrl = frameAdminLogoUrl(path)
  if (frameAdminUrl) {
    return frameAdminUrl
  }

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
