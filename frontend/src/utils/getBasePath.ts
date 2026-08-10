function stripTrailingSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path
}

export function getBasePath(): string {
  const basePath = typeof window !== 'undefined' ? (window as any).FRAMEOS_APP_CONFIG?.ingress_path || '' : ''
  return stripTrailingSlash(basePath)
}

// Where the SPA's routes live. Usually the same as the API base path
// (ingress_path), but the cloud wrapper mounts routes under /frames while
// its API stays at the origin root, so it sets route_base_path separately.
export function getRouteBasePath(): string {
  const routeBasePath = typeof window !== 'undefined' ? (window as any).FRAMEOS_APP_CONFIG?.route_base_path : undefined
  return typeof routeBasePath === 'string' ? stripTrailingSlash(routeBasePath) : getBasePath()
}

// Where root-absolute public assets (/img, /frameos-wasm, /static/monaco)
// are served from. The cloud wrapper serves them under /frames-app via
// Next's public/ folder; everywhere else this is the ingress path.
export function getAssetsBasePath(): string {
  const assetsBasePath =
    typeof window !== 'undefined' ? (window as any).FRAMEOS_APP_CONFIG?.assets_base_path : undefined
  return typeof assetsBasePath === 'string' ? stripTrailingSlash(assetsBasePath) : getBasePath()
}
