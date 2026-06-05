import { router } from 'kea-router'
import type { routerPlugin } from 'kea-router'
import { getBasePath } from './getBasePath'
import { inHassioIngress } from './inHassioIngress'

type RouterPluginOptions = NonNullable<Parameters<typeof routerPlugin>[0]>
type RouterLocation = NonNullable<RouterPluginOptions['location']>
type HistoryMethod = 'pushState' | 'replaceState'

let installed = false

function accessibleParentWindow(): Window | null {
  if (typeof window === 'undefined' || !inHassioIngress() || window.parent === window) {
    return null
  }

  try {
    void window.parent.location.href
    void window.parent.history.state
    return window.parent
  } catch {
    return null
  }
}

function parseUrl(url: string): RouterLocation {
  let pathname = url || '/'
  let search = ''
  let hash = ''

  const hashIndex = pathname.indexOf('#')
  if (hashIndex !== -1) {
    hash = pathname.slice(hashIndex)
    pathname = pathname.slice(0, hashIndex)
  }

  const searchIndex = pathname.indexOf('?')
  if (searchIndex !== -1) {
    search = pathname.slice(searchIndex)
    pathname = pathname.slice(0, searchIndex)
  }

  return { pathname: pathname || '/', search: search === '?' ? '' : search, hash: hash === '#' ? '' : hash }
}

function addBasePath(pathname: string): string {
  const basePath = getBasePath()
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`

  if (!basePath || normalizedPath === basePath || normalizedPath.startsWith(`${basePath}/`)) {
    return normalizedPath
  }

  return normalizedPath === '/' ? basePath : `${basePath}${normalizedPath}`
}

function removeBasePath(pathname: string): string {
  const basePath = getBasePath()

  if (basePath && pathname === basePath) {
    return '/'
  }

  if (basePath && pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length) || '/'
  }

  return pathname || '/'
}

function parentHashToLocation(hash: string): RouterLocation | null {
  if (!hash.startsWith('#/')) {
    return null
  }

  const location = parseUrl(hash.slice(1))
  return {
    pathname: addBasePath(location.pathname),
    search: location.search,
    hash: location.hash,
  }
}

function locationToParentHash(url: string): string {
  const location = parseUrl(url)
  return `#${removeBasePath(location.pathname)}${location.search}${location.hash}`
}

function readParentHashLocation(): RouterLocation | null {
  const parent = accessibleParentWindow()
  return parent ? parentHashToLocation(parent.location.hash) : null
}

function mirrorUrlToParent(url: string, method: HistoryMethod): void {
  const parent = accessibleParentWindow()
  if (!parent) {
    return
  }

  const nextHash = locationToParentHash(url)
  if (parent.location.hash === nextHash) {
    return
  }

  parent.history[method](parent.history.state, '', `${parent.location.pathname}${parent.location.search}${nextHash}`)
}

function currentRouterUrl(): string {
  const { pathname, search, hash } = router.values.location
  return `${pathname}${search}${hash}`
}

function syncFromParentHash(): void {
  const location = readParentHashLocation()
  if (!location) {
    return
  }

  const url = `${location.pathname}${location.search}${location.hash}`
  if (url !== currentRouterUrl()) {
    router.actions.replace(url)
  }
}

export function hassioIngressParentRouterOptions(): RouterPluginOptions {
  const parentLocation = readParentHashLocation()
  const parent = accessibleParentWindow()

  if (!parent) {
    return {}
  }

  return {
    ...(parentLocation ? { location: parentLocation } : {}),
    history: {
      pushState(_state, _title, url) {
        mirrorUrlToParent(url, 'pushState')
      },
      replaceState(_state, _title, url) {
        mirrorUrlToParent(url, 'replaceState')
      },
    },
  }
}

export function installHassioIngressParentRouter(): void {
  const parent = accessibleParentWindow()
  if (!parent || installed) {
    return
  }

  installed = true
  parent.addEventListener('hashchange', syncFromParentHash)
  parent.addEventListener('popstate', syncFromParentHash)
}
