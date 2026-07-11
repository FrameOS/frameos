# frameos-editor

The [FrameOS](https://frameos.net) visual scene editor — the same node-graph editor the FrameOS
backend ships — as an embeddable static bundle. No backend needed: the app catalog and app sources
are embedded at build time, scenes go in and come back out as JSON over `postMessage`. JS app
sources can be viewed and edited in the built-in Monaco editor.

The package version always equals the FrameOS release it was built from.

**License: AGPL-3.0-only.** The editor is FrameOS code. The intended embedding model is an iframe
served from your own host, talking to your page over the documented `postMessage` protocol — the
editor stays a separate program at arm's length, whatever the license of the embedding page. If you
modify the bundle itself, AGPL terms apply to those modifications.

## Usage

Serve this package's `dist/` directory from your host (e.g. copy it to `/frameos-editor/`), then:

```js
import { createFrameOSEditor } from 'frameos-editor'

const editor = createFrameOSEditor({
  container: document.getElementById('editor'),
  url: '/frameos-editor/index.html',
  scenes,               // parsed scenes.json
  width: 800,
  height: 480,
  onScenesChanged: (scenes) => console.log('edited', scenes),
})

const edited = await editor.getScenes()
editor.destroy()
```

## postMessage protocol

Parent → editor:

- `{type: 'frameos-editor:init', scenes, sceneId?, mode?, width?, height?, interval?}`
- `{type: 'frameos-editor:get-scenes'}` — replies with a `:scenes` message
- `{type: 'frameos-editor:select-scene', sceneId}`

Editor → parent:

- `{type: 'frameos-editor:ready'}` — once listening (the helper auto-sends `init` on this)
- `{type: 'frameos-editor:scenes', scenes}` — after every edit (debounced) and as the
  `:get-scenes` reply

## Demo

`demo.html` shows the scene list, the editor, and (when the [`frameos-wasm`](https://www.npmjs.com/package/frameos-wasm)
package's assets are served next to it at `./frameos-wasm/`) a live WebAssembly preview of the
edited scenes — everything running in the browser.

## Development (FrameOS repo)

The bundle is built by `frontend/build.mjs` ("FrameOS Embedded Editor" config: the regular editor
code with `frameLogic`/`logsLogic` swapped for in-memory shims, see `frontend/src/embed/`) into
`frontend/dist-editor/`, and copied into this package's `dist/` by `npm run build`. Smoke test:
`node frontend/scripts/smokeEditorEmbed.mjs`.
