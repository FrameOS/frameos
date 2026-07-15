# frameos-wasm

Run [FrameOS](https://frameos.net) scenes in the browser through WebAssembly. The package wraps the
emscripten-built FrameOS scene runtime with a typed API and ships a minimal management interface:
a live canvas, scene switching, showIf-aware state fields, event buttons, and logs — the same
control surface a frame exposes on-device.

The package version always equals the FrameOS release the runtime was built from.

## Install

```sh
npm install frameos-wasm
```

The runtime assets (`frameos.js`, `frameos.wasm`, `preview-worker.js`) live in
`frameos-wasm/dist/assets/`. They must be served **same-origin** (the runtime runs in a module Web
Worker and uses synchronous XHR): copy that directory into your static assets, e.g. to
`/frameos-wasm/`.

## Quick start — management interface

```ts
import { mountFrameOSManager } from 'frameos-wasm'

const handle = mountFrameOSManager(document.getElementById('preview')!, {
  workerUrl: '/frameos-wasm/preview-worker.js',
  width: 800,
  height: 480,
  scenes, // parsed scenes.json (from a template zip, backup, or export)
})
// later: handle.preview.sendEvent('myButton'), handle.destroy()
```

## Lower level — just the runtime

```ts
import { createFrameOSPreview } from 'frameos-wasm'

const preview = createFrameOSPreview({
  workerUrl: '/frameos-wasm/preview-worker.js',
  width: 800,
  height: 480,
  scenes,
  canvas: document.querySelector('canvas'),
  onLog: (line) => console.log(line),
  onState: (state) => console.log('scene state', state),
})
preview.setSceneState({ message: 'Hello' })
preview.sendEvent('button', { label: 'a' })
preview.selectScene('sceneId')
preview.destroy()
```

Helpers for building your own UI are exported too: `evaluateShowIf`, `visiblePublicStateFields`,
`coerceStateFieldValue`, `sceneEventButtons`, and the `StateField`/`FrameOSScene` types.

## Notes

- Scenes that fetch external URLs are subject to browser CORS unless you pass `proxyUrl` (a
  same-origin endpoint that forwards `{method, url, headers, bodyBase64, timeoutMs}` — see
  FrameOS's `/api/frames/{id}/scene_preview_proxy`).
- Apps that need host processes are not in the wasm build: `data/chromiumScreenshot`,
  `data/rstpSnapshot`, `data/localImage`.
- `index.html` in the package root is a standalone demo page:
  `npx serve node_modules/frameos-wasm` and paste a scenes.json.

## Development (FrameOS repo)

The runtime assets are built by `frameos/tools/build_wasm.sh` into `frontend/public/frameos-wasm`
and copied into `dist/assets` by `npm run build`. `npm run sync-version` copies the FrameOS
version out of the repo's `versions.json`; publishing refuses to run when the two disagree.
