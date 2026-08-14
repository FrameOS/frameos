import { assetUrl } from './assetUrl'

export type FrameosTheme = 'light' | 'dark'

// Four icons, not two: the theme picks the outline colour (dark glyph on a
// light tab strip, white glyph on a dark one) and "am I on localhost" picks
// whether the three squares keep their colours. A developer usually has the
// real deployment open in another tab; the monochrome icon is what tells the
// two apart at a glance.
//
// Keep in sync with the inline pre-paint scripts in frontend/src/index.html
// and cloud-frontend/src/index.html — they run before this module loads and
// have to reach the same answer, or the icon visibly flips on boot.
const faviconPaths: Record<FrameosTheme, { colour: string; mono: string }> = {
  light: { colour: '/img/logo-2/logo.svg', mono: '/img/logo-2/logo-black.svg' },
  dark: { colour: '/img/logo-2/logo-white-colors.svg', mono: '/img/logo-2/logo-white.svg' },
}

/**
 * Is this page being served from a development machine rather than a real
 * deployment? Loopback names only: a LAN IP or a `.local` mDNS name is how you
 * reach an actual frame or a self-hosted backend on the network, and those are
 * production as far as the person looking at the tab is concerned.
 */
export function isLocalFrameosHost(hostname?: string): boolean {
  const host = (hostname ?? (typeof window === 'undefined' ? '' : window.location.hostname)).toLowerCase()
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]'
  )
}

export function applyFrameosTheme(theme: FrameosTheme): void {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.dataset.frameosTheme = theme
  document.documentElement.style.colorScheme = theme
  applyFrameosFavicon(theme)
}

function applyFrameosFavicon(theme: FrameosTheme): void {
  if (typeof document === 'undefined') {
    return
  }

  const paths = faviconPaths[theme]
  const href = assetUrl(isLocalFrameosHost() ? paths.mono : paths.colour)
  let favicon = document.querySelector<HTMLLinkElement>('link[data-frameos-favicon]')
  if (!favicon) {
    favicon = document.createElement('link')
    favicon.rel = 'icon'
    favicon.type = 'image/svg+xml'
    favicon.dataset.frameosFavicon = ''
    document.head.appendChild(favicon)
  }
  if (favicon.getAttribute('href') !== href) {
    favicon.setAttribute('href', href)
  }
}
