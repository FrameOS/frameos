#!/usr/bin/env node
// The Kitchen sink in a layout, in the memory of an ESP32-S3 with 8 MB of PSRAM
// (the SenseCAP Indicator): the wasm build of the runtime with its heap capped
// to what that board has (docs/device-limits-fixtures.json), played through the
// way a person would. It fails on a render that runs out of memory, an error
// frame, or a page or a brush stroke that does not reach the picture.
//
//   frameos/tools/build_wasm.sh --out DIR
//   node frameos/tools/esp32_kitchen_sink.mjs DIR
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const wasmDir = resolve(process.argv[2] ?? join(root, 'frontend', 'public', 'frameos-wasm'))
const readJson = async (...path) => JSON.parse(await readFile(join(root, ...path), 'utf8'))

const WIDTH = 480
const HEIGHT = 480
const WIRE_MAX = 32767
const TAB_Y = 448
const PAINT_TAB_X = 144
const LIGHTS_TAB_X = 240
const STROKES = 40

const limits = (await readJson('docs', 'device-limits-fixtures.json')).cases.find(
  (entry) => entry.width === WIDTH && entry.height === HEIGHT && entry.pixelFormat === 9
)
if (!limits) throw new Error('no 480x480 RGB565 case in docs/device-limits-fixtures.json')

const fail = (message) => {
  console.error(`FAILED: ${message}`)
  process.exit(1)
}

const { default: createFrameOS } = await import(pathToFileURL(join(wasmDir, 'frameos.js')).href)
const sceneErrors = []
const Module = await createFrameOS({
  wasmBinary: await readFile(join(wasmDir, 'frameos.wasm')),
  print: () => {},
  printErr: (line) => console.error(`[frameos] ${line}`),
  onFrameosLog: (line) => {
    if (/js:interpreterDiscarded|jsApp:error|scene:error|outOfMemory/.test(line)) sceneErrors.push(line)
  },
})
const call = (name, ret, types, args) => Module.ccall(name, ret, types, args)
const lastError = () => call('frameos_wasm_last_error', 'string', [], [])

if (!call('frameos_wasm_init', 'boolean', ['number', 'number', 'string', 'string', 'string'],
  [WIDTH, HEIGHT, 'kitchen sink check', 'UTC', '{}'])) {
  fail(`init: ${lastError()}`)
}
call('frameos_wasm_set_memory_limit', null, ['number', 'number'], [limits.memoryBytes, 0])
call('frameos_wasm_set_embedded', null, ['boolean'], [true])
call('frameos_wasm_set_canvas_bits_per_pixel', null, ['number'], [limits.canvasBytesPerPixel * 8])

const rawSink = await readJson('e2e', 'scenes', 'jsxSquareKitchenSink.json')
const sink = Array.isArray(rawSink) ? rawSink[0] : rawSink
const [topBar] = await readJson('repo', 'scenes', 'samples', 'Top bar layout', 'scenes.json')
if (call('frameos_wasm_load_scenes', 'number', ['string'],
  [JSON.stringify([topBar, { ...sink, layout: { sceneId: topBar.id } }])]) < 2) {
  fail(`load scenes: ${lastError()}`)
}
if (!call('frameos_wasm_select_scene', 'boolean', ['string'], [sink.id])) fail('select scene')

let renders = 0
function render(step) {
  const rc = call('frameos_wasm_render', 'number', [], [])
  renders += 1
  if (rc === 3) {
    fail(`${step}: out of memory, ${call('frameos_wasm_memory_used', 'number', [], [])} of ${limits.memoryBytes} bytes in use`)
  }
  if (rc !== 0) fail(`${step}: render returned ${rc}: ${lastError()}`)
}
function settle(step) {
  call('frameos_wasm_tick', 'boolean', [], [])
  render(step)
  for (let again = 0; again < 8 && call('frameos_wasm_render_requested', 'number', [], []); again += 1) {
    render(step)
  }
}
const picture = () => {
  const start = call('frameos_wasm_buffer', 'number', [], [])
  const length = call('frameos_wasm_buffer_len', 'number', [], [])
  return Module.HEAPU8.slice(start, start + length)
}
const changedPixels = (a, b) => {
  let changed = 0
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changed += 1
  }
  return changed
}
const pointer = (event, x, y, buttons) => {
  call('frameos_wasm_event', 'boolean', ['string', 'string'], [event, JSON.stringify({
    x: Math.round((x * WIRE_MAX) / (WIDTH - 1)),
    y: Math.round((y * WIRE_MAX) / (HEIGHT - 1)),
    pointerId: 1, pointerType: 'touch', button: 0, buttons,
  })])
}
function tap(step, x, y) {
  const before = picture()
  pointer('pointerDown', x, y, 1)
  pointer('pointerUp', x, y, 0)
  settle(step)
  const changed = changedPixels(before, picture())
  // A page is thousands of pixels; a clock's digits are a few hundred.
  if (changed < 4000) fail(`${step}: the page did not change (${changed} pixels)`)
}
function stroke(step, offset) {
  // Each on a cell of its own: over an earlier one it would change nothing.
  const before = picture()
  const [x0, y0] = [40 + (offset % 8) * 48, 150 + (Math.floor(offset / 8) % 5) * 40]
  pointer('pointerDown', x0, y0, 1)
  for (let i = 1; i <= 8; i += 1) {
    pointer('pointerMove', x0 + i * 4, y0, 1)
    settle(step)
  }
  pointer('pointerUp', x0 + 32, y0, 0)
  settle(step)
  if (changedPixels(before, picture()) < 40) fail(`${step}: the stroke did not reach the picture`)
}

settle('first render')
settle('second render')
tap('open Paint', PAINT_TAB_X, TAB_Y)
for (let i = 0; i < STROKES; i += 1) stroke(`stroke ${i + 1}`, i)
tap('open Lights', LIGHTS_TAB_X, TAB_Y)
tap('back on Paint', PAINT_TAB_X, TAB_Y)

const peak = call('frameos_wasm_memory_peak', 'number', [], [])
if (sceneErrors.length > 0) fail(`the scene reported:\n${sceneErrors.slice(0, 5).join('\n')}`)
console.log(`ok: ${renders} renders, peak ${(peak / 1048576).toFixed(2)} of ${(limits.memoryBytes / 1048576).toFixed(2)} MiB`)
