import { assetUrl } from './assetUrl'

export type FrameosTheme = 'light' | 'dark'

const faviconPaths: Record<FrameosTheme, string> = {
  light: '/img/logo-2/logo.svg',
  dark: '/img/logo-2/logo-white-colors.svg',
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

  const href = assetUrl(faviconPaths[theme])
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
