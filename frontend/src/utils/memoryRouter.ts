import type { routerPlugin } from 'kea-router'

type RouterPluginOptions = NonNullable<Parameters<typeof routerPlugin>[0]>
type RouterLocation = NonNullable<RouterPluginOptions['location']>

// The embedded editor's routes are internal state: opening an app's code is
// `/apps/<frameId>/<sceneId>/<nodeId>`, resolved against the asset base path
// (FRAMEOS_APP_CONFIG.ingress_path, e.g. /frameos-editor). The host page owns
// the real URL — FrameOS Cloud mounts the editor straight into its scene page,
// no iframe — so writing those routes to window.history replaces a URL the
// host understands with one only the editor does: the address bar turns into
// /frameos-editor/apps/1/<scene>/<node>, and the next navigation to it (a
// reload, or Next's router.refresh() after a save) 404s.
//
// So the embed keeps its location in memory. Routing works exactly as before
// — push/replace still run urlToAction — it just leaves the browser alone.
export function memoryRouterOptions(): RouterPluginOptions {
  const location: RouterLocation = { pathname: '/', search: '', hash: '' }

  function remember(url: string): void {
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

    location.pathname = pathname || '/'
    location.search = search === '?' ? '' : search
    location.hash = hash === '#' ? '' : hash
  }

  return {
    location,
    history: {
      pushState(_state, _title, url) {
        remember(url)
      },
      replaceState(_state, _title, url) {
        remember(url)
      },
    },
  }
}
