import { assetUrl } from './assetUrl'
import { isCloudMode } from './cloudMode'

export type FrameosTheme = 'light' | 'dark'

// Four icons, not two: the glyph colour has to contrast with the TAB STRIP,
// and "am I on localhost" picks whether the three squares keep their colours.
// A developer usually has the real deployment open in another tab; the
// monochrome icon is what tells the two apart at a glance.
//
// Two marks, one per product: the self-hosted backend and the on-device
// admin wear the rectangular FrameOS logo, and FrameOS Cloud wears the
// cloud-shaped mark its account pages already use — the icon is how the two
// tabs tell apart, so the workspace must not switch marks depending on which
// control plane serves it. The cloud files live at the auth-web public ROOT
// (served for /frames too, same origin), so they take no assets base path.
//
// Keep in sync with the inline pre-paint scripts in frontend/src/index.html
// and cloud-frontend/src/index.html — they run before this module loads and
// have to reach the same answer, or the icon visibly flips on boot.
const backendFaviconPaths: Record<FrameosTheme, { colour: string; mono: string }> = {
  light: { colour: '/img/logo-2/logo.svg', mono: '/img/logo-2/logo-black.svg' },
  dark: { colour: '/img/logo-2/logo-white-colors.svg', mono: '/img/logo-2/logo-white.svg' },
}
const cloudFaviconPaths: Record<FrameosTheme, { colour: string; mono: string }> = {
  light: { colour: '/logo-light.svg', mono: '/logo-light-mono.svg' },
  dark: { colour: '/logo-dark.svg', mono: '/logo-dark-mono.svg' },
}

const darkChromeQuery = '(prefers-color-scheme: dark)'

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

/**
 * Which icon the BROWSER's own colours call for.
 *
 * Deliberately not the workspace theme. A favicon is painted into the tab
 * strip, not into the page, so the only thing it has to contrast with is the
 * browser chrome — and the two disagree constantly: a dark Chrome with the
 * workspace set to light was drawing the black glyph onto a dark tab strip,
 * where it was all but invisible. `prefers-color-scheme` is what the chrome
 * follows, so it is what the icon follows.
 */
function prefersDarkChrome(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(darkChromeQuery).matches
}

export function applyFrameosTheme(theme: FrameosTheme): void {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.dataset.frameosTheme = theme
  document.documentElement.style.colorScheme = theme
  // The favicon takes no argument: it does not depend on `theme` at all.
  applyFrameosFavicon()
}

let watchingChromeScheme = false

export function applyFrameosFavicon(): void {
  if (typeof document === 'undefined') {
    return
  }

  const scheme: FrameosTheme = prefersDarkChrome() ? 'dark' : 'light'
  const cloud = isCloudMode()
  const paths = (cloud ? cloudFaviconPaths : backendFaviconPaths)[scheme]
  const path = isLocalFrameosHost() ? paths.mono : paths.colour
  // assetUrl would prefix the assets base (/frames-app); the cloud icons are
  // root-served on purpose so /frames and the account pages share one file.
  const href = cloud ? path : assetUrl(path)
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

  // Switching the OS or browser between light and dark has to repaint the
  // icon; nothing else in the app re-runs on that event, because the
  // workspace theme may well be pinned and unaffected by it. Registered once,
  // lazily, so importing this module costs nothing.
  if (!watchingChromeScheme && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    watchingChromeScheme = true
    const media = window.matchMedia(darkChromeQuery)
    const onChange = (): void => applyFrameosFavicon()
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
    } else if (typeof media.addListener === 'function') {
      // Safari < 14.
      media.addListener(onChange)
    }
  }
}
