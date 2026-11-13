# frameos-editor

The [FrameOS](https://frameos.net) visual scene editor — the same node-graph editor the FrameOS
backend ships — as an embeddable static bundle. No backend needed: the app catalog and app sources
are embedded at build time, scenes go in and come back out as JSON over `postMessage`. The editor
carries the full scene workspace as a file tree: `template.json` (the template's name, description,
category and tags, as a form or as JSON), then every scene as a folder: its diagram (`scene.json`,
with side panels for scene settings, state variables, the app catalog, events and raw scene JSON)
and the apps the scene carries the source of, as folders of files, each opening in the editor pane
(Monaco, `config.json` as a form). Built-in apps are not listed: a node's "Edit app" shows them in
a modal. The
React component's `template` / `onTemplateChanged` / `templateCategories` props drive
`template.json` (`templateContent` replaces its form with the host's own view, `initialFile:
'template'` opens on it); without them it is read only. `initialAppFile: 'app.tsx'` opens on that
file of the shown scene's first app that has it, and `initialTreeOpen: false` starts with the tree folded.
When the [`frameos-wasm`](https://www.npmjs.com/package/frameos-wasm) package's assets are served
next to the bundle (at `./frameos-wasm/` relative to `dist/`), the Preview panel runs the edited
scenes live through the FrameOS WebAssembly runtime — canvas, scene state and runtime logs included.

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

**Origins.** The editor only accepts messages from the window that framed it, and only from an origin it
knows: pass your page's origin on the iframe URL — `editor.html?parentOrigin=https://your.host` (repeat or
comma-separate for several) — or leave it out and the document that framed the editor (its referrer origin)
is the one host allowed. Replies are posted to that origin, never to `*`. `previewProxyUrl` is honoured only
when it points back at the editor's own origin.

Parent → editor:

- `{type: 'frameos-editor:init', scenes, sceneId?, mode?, width?, height?, interval?, theme?, previewProxyUrl?, description?, template?, templateFields?}` —
  `theme` is `'light' | 'dark'`; `previewProxyUrl` is an optional same-origin endpoint the in-editor wasm live
  preview routes CORS-blocked HTTP requests through; `description` is the embedding page's description of the
  scene, shown in the Scene settings panel; `template` (`{name, description, category, tags, frameosVersion}`) makes
  `template.json` editable — the editor opens on it and reports every change; `templateFields` names the fields
  the host keeps, and the form edits those alone (default: all but `name`)
- `{type: 'frameos-editor:get-scenes'}` — replies with a `:scenes` message
- `{type: 'frameos-editor:select-scene', sceneId}`

Editor → parent:

- `{type: 'frameos-editor:ready'}` — once listening (the helper auto-sends `init` on this)
- `{type: 'frameos-editor:scenes', scenes}` — after every edit (debounced) and as the
  `:get-scenes` reply
- `{type: 'frameos-editor:template', template}` — after every edit to `template.json`, when `init` sent a
  `template`
- `{type: 'frameos-editor:save-screenshot', dataUrl, sceneId}` — the Preview panel captured a frame;
  reply with `{type: 'frameos-editor:screenshot-saved', ok, error?, fallbackDownload?}` to store it
  yourself, or stay silent and the editor downloads the PNG locally after a short timeout

## Demo

`demo.html` shows the scene list, the editor, and (when the [`frameos-wasm`](https://www.npmjs.com/package/frameos-wasm)
package's assets are served next to it at `./frameos-wasm/`) a live WebAssembly preview of the
edited scenes — everything running in the browser.

## Development (FrameOS repo)

The bundle is built by `frontend/build.mjs` ("FrameOS Embedded Editor" config: the regular editor
code with `frameLogic`/`logsLogic` swapped for in-memory shims, see `frontend/src/embed/`) into
`frontend/dist-editor/`, and copied into this package's `dist/` by `npm run build`. Smoke test:
`node frontend/scripts/smokeEditorEmbed.mjs`.
