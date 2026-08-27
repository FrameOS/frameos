// @vitest-environment jsdom
//
// The scene editor is mounted straight into this app's scene page (no
// iframe), so it shares the window with Next's router. Its own routes are
// internal state — "edit this app" pushes /apps/<frame>/<scene>/<node>,
// resolved against the editor's asset base path — and while it wrote those
// to window.history the address bar of a published scene turned into
// /frameos-editor/apps/1/<scene>/<node>. Nothing serves that path: saving
// (which ends in router.refresh()) or a plain reload landed on a 404.
//
// Embedded builds route in memory instead: pushes still drive the editor,
// they just never touch the host page's URL.

import { beforeEach, describe, expect, it } from 'vitest'
// Through the frontend's own copy: kea-router is its dependency, not this
// app's, and initKea builds the plugin from that same module.
import { router } from '../../../../../../frontend/node_modules/kea-router'
import { initKea } from '../../../../../../frontend/src/initKea'

const hostUrl = '/s/visited-world-map#scene-editor'

describe("the embedded editor's router", () => {
  beforeEach(() => {
    window.history.replaceState(null, '', hostUrl)
  })

  it("routes in memory, leaving the host page's URL alone", () => {
    initKea({ memoryRouter: true })
    router.mount()

    router.actions.push('/frameos-editor/apps/1/visited-world-map/world-map-panel')

    // The editor knows where it is...
    expect(router.values.location.pathname).toBe('/frameos-editor/apps/1/visited-world-map/world-map-panel')
    // ...and the page the host serves is still the page in the address bar.
    expect(`${window.location.pathname}${window.location.hash}`).toBe(hostUrl)
  })

  it('still writes the URL when the SPA owns the window', () => {
    initKea()
    router.mount()

    router.actions.push('/frames/1')

    expect(window.location.pathname).toBe('/frames/1')
  })
})
