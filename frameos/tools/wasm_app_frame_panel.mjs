#!/usr/bin/env node
// `app.frame.fast`, `paper` and `color` in the wasm runtime, read in every phase a JS
// app runs (init(), get(), onEvent, a JSX handler, after an await): what the
// panel is, never the canvas, which only a render has. The browser preview
// says the browser's (an LCD), and running as an ESP32 a grey board where its
// canvas is 4 or 8 bits; a plane drawing for a board says that board's panel
// (`frameos_wasm_set_frame`'s `pixelFormat`). Until 2026-11-16 an event read
// the plane's RGBX canvas there: color on the grey preview, and on an ESP32
// e-paper on an LCD (frameos/src/frameos/tests/test_app_frame_panel.nim).
//
//   frameos/tools/build_wasm.sh --out DIR
//   node frameos/tools/wasm_app_frame_panel.mjs DIR
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const wasmDir = resolve(process.argv[2] ?? join(root, 'frontend', 'public', 'frameos-wasm'))

const WIDTH = 80
const HEIGHT = 60
const PHASES = ['init', 'get', 'onEvent', 'onClick', 'awaited']

const fail = (message) => {
  console.error(`FAILED: ${message}`)
  process.exit(1)
}

const source = `const seen: Record<string, any> = {}
function heard(phase: string, app: FrameOSApp) {
  seen[phase] = { fast: app.frame.fast, paper: app.frame.paper, color: app.frame.color }
  frameos.setState('seen', seen)
}

export async function init(app: FrameOSApp) {
  heard('init', app)
  // Nothing pumps here, so no timer fires: a settled promise is what goes on
  // (docs/async-js.md, a blocking fetch's).
  await Promise.resolve()
  heard('awaited', app)
}

export function onEvent(app: FrameOSApp) {
  heard('onEvent', app)
  return false
}

export function get(app: FrameOSApp) {
  heard('get', app)
  return <div className="w-full h-full bg-white" onClick={() => heard('onClick', app)} />
}
`
const config = {
  name: 'Panel probe', category: 'data', fields: [], events: ['pointerDown'], output: [{ name: 'image', type: 'image' }],
}
const scene = {
  id: 'panel-probe',
  name: 'Panel probe',
  settings: { execution: 'interpreted', refreshInterval: 3600, backgroundColor: '#ffffff' },
  fields: [],
  apps: { panelProbe: { ...config, sources: { 'config.json': JSON.stringify(config), 'app.tsx': source } } },
  nodes: [
    { id: 'render', type: 'event', position: { x: 0, y: 0 }, data: { keyword: 'render' } },
    { id: 'app', type: 'app', position: { x: 300, y: -190 }, data: { keyword: 'panelProbe', config: {} } },
    { id: 'draw', type: 'app', position: { x: 300, y: 0 }, data: { keyword: 'render/image', config: { placement: 'stretch' } } },
  ],
  edges: [
    { id: 'render-draw', type: 'appNodeEdge', source: 'render', target: 'draw', sourceHandle: 'next', targetHandle: 'prev' },
    { id: 'app-draw', type: 'codeNodeEdge', source: 'app', target: 'draw', sourceHandle: 'fieldOutput', targetHandle: 'fieldInput/image' },
  ],
}

const { default: createFrameOS } = await import(pathToFileURL(join(wasmDir, 'frameos.js')).href)
const wasmBinary = await readFile(join(wasmDir, 'frameos.wasm'))

// `setup` is what the page or the plane says of the frame before the scenes
// load; then a render and a tap, as the preview's page sends one.
async function check(label, setup, want) {
  const problems = []
  const Module = await createFrameOS({
    wasmBinary,
    print: () => {},
    printErr: (line) => console.error(`[frameos] ${line}`),
    onFrameosLog: (line) => {
      if (/jsApp:error|scene:error|event:error/.test(line)) problems.push(line)
    },
  })
  const call = (name, ret, types, args) => Module.ccall(name, ret, types, args)
  const lastError = () => call('frameos_wasm_last_error', 'string', [], [])
  if (!call('frameos_wasm_init', 'boolean', ['number', 'number', 'string', 'string', 'string'],
    [WIDTH, HEIGHT, 'panel check', 'UTC', '{}'])) {
    fail(`${label}: init: ${lastError()}`)
  }
  setup(call)
  if (call('frameos_wasm_load_scenes', 'number', ['string'], [JSON.stringify([scene])]) < 1) {
    fail(`${label}: load scenes: ${lastError()}`)
  }
  if (!call('frameos_wasm_select_scene', 'boolean', ['string'], [scene.id])) fail(`${label}: select scene`)
  const rc = call('frameos_wasm_render', 'number', [], [])
  if (rc !== 0) fail(`${label}: render returned ${rc}: ${lastError()}`)
  const at = { x: WIDTH >> 1, y: HEIGHT >> 1, pointerId: 1, pointerType: 'touch', button: 0 }
  call('frameos_wasm_event', 'boolean', ['string', 'string'], ['pointerDown', JSON.stringify({ ...at, buttons: 1 })])
  call('frameos_wasm_event', 'boolean', ['string', 'string'], ['pointerUp', JSON.stringify({ ...at, buttons: 0 })])
  if (problems.length > 0) fail(`${label}: the scene reported:\n${problems.slice(0, 5).join('\n')}`)

  const seen = JSON.parse(call('frameos_wasm_scene_state', 'string', [], [])).seen ?? {}
  for (const phase of PHASES) {
    const got = seen[phase]
    if (!got) fail(`${label}: ${phase} never ran (heard: ${JSON.stringify(seen)})`)
    // Today fast is paper's opposite on every panel (panel_shape.panelIsFast).
    const fast = !want.paper
    if (got.fast !== fast || got.paper !== want.paper || got.color !== want.color) {
      fail(`${label}: ${phase} read fast ${got.fast}, paper ${got.paper}, color ${got.color}; ` +
        `the panel is fast ${fast}, paper ${want.paper}, color ${want.color}`)
    }
  }
  console.log(`ok: ${label}: fast ${!want.paper}, paper ${want.paper}, color ${want.color} in ${PHASES.join(', ')}`)
}

const asEsp32 = (bits) => (call) => {
  call('frameos_wasm_set_embedded', null, ['boolean'], [true])
  call('frameos_wasm_set_canvas_bits_per_pixel', null, ['number'], [bits])
}
const forBoard = (pixelFormat, bits) => (call) => {
  asEsp32(bits)(call)
  if (!call('frameos_wasm_set_frame', 'boolean', ['string'], [JSON.stringify({ pixelFormat })])) {
    fail(`set_frame ${pixelFormat}`)
  }
}

await check('the browser preview', () => {}, { paper: false, color: true })
await check('the preview as a sixteen-grey ESP32', asEsp32(4), { paper: true, color: false })
await check('the preview as a grey ESP32', asEsp32(8), { paper: true, color: false })
await check('the preview as an ESP32 LCD', asEsp32(16), { paper: false, color: true })
await check('a plane drawing for a reTerminal E1003', forBoard(8, 4), { paper: true, color: false })
await check('a plane drawing for a SenseCAP Indicator', forBoard(9, 16), { paper: false, color: true })
// A 13.3" Spectra 6 on 8 MB draws in RGB565, as an LCD does.
await check('a plane drawing for a reTerminal E1004', forBoard(7, 16), { paper: true, color: true })
