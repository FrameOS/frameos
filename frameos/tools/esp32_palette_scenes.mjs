#!/usr/bin/env node
// The 8-bit palette samples (Pixel toys, Hellfire among them, and Color cycling) in the
// memory of an ESP32-S3 with 8 MB of PSRAM (the SenseCAP Indicator): the wasm
// build of the runtime with its heap capped to what that board has
// (docs/device-limits-fixtures.json). Every effect and every scene, a few
// dozen frames each, the FPS counters, and swipes. It fails on a render that
// runs out of memory or returns an error, a scene error or a discarded
// interpreter, a picture that stops moving, memory that keeps growing, frames
// that get slower as they run, a frame far past any budget, and a swipe that
// does not change the effect.
//
//   frameos/tools/build_wasm.sh --out DIR
//   node frameos/tools/esp32_palette_scenes.mjs DIR
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const wasmDir = resolve(process.argv[2] ?? join(root, 'frontend', 'public', 'frameos-wasm'))
const readJson = async (...path) => JSON.parse(await readFile(join(root, ...path), 'utf8'))

const WIDTH = 480
const HEIGHT = 480
const WIRE_MAX = 32767
const FRAMES = 40
// A frame of a host's wasm is a small part of a board's; one this slow means
// something is being made again every frame (an interpreter, a palette).
const FRAME_CEILING_MS = 250

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
  [WIDTH, HEIGHT, 'palette scenes check', 'UTC', '{}'])) {
  fail(`init: ${lastError()}`)
}
call('frameos_wasm_set_memory_limit', null, ['number', 'number'], [limits.memoryBytes, 0])
call('frameos_wasm_set_embedded', null, ['boolean'], [true])
call('frameos_wasm_set_canvas_bits_per_pixel', null, ['number'], [limits.canvasBytesPerPixel * 8])

const [toys] = await readJson('repo', 'scenes', 'samples', 'Pixel toys', 'scenes.json')
const [cycling] = await readJson('repo', 'scenes', 'samples', 'Color cycling', 'scenes.json')
// A tenth of a second of cycling a render, so every frame moves however fast
// this host renders.
cycling.nodes.find((node) => node.id === 'cycling').data.config.msPerRender = '100'
if (call('frameos_wasm_load_scenes', 'number', ['string'], [JSON.stringify([toys, cycling])]) < 2) {
  fail(`load scenes: ${lastError()}`)
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
const memoryUsed = () => call('frameos_wasm_memory_used', 'number', [], [])
const stateNow = () => JSON.parse(call('frameos_wasm_scene_state', 'string', [], []) || '{}')

let renders = 0
function render(step) {
  const started = performance.now()
  const rc = call('frameos_wasm_render', 'number', [], [])
  const ms = performance.now() - started
  renders += 1
  if (rc === 3) fail(`${step}: out of memory, ${memoryUsed()} of ${limits.memoryBytes} bytes in use`)
  if (rc !== 0) fail(`${step}: render returned ${rc}: ${lastError()}`)
  if (sceneErrors.length > 0) fail(`${step}: the scene reported:\n${sceneErrors.slice(0, 5).join('\n')}`)
  return ms
}

const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1]
const report = []

function play(name, sceneId, state) {
  if (!call('frameos_wasm_select_scene', 'boolean', ['string'], [sceneId])) fail(`${name}: select scene`)
  call('frameos_wasm_set_scene_state', null, ['string', 'string'], [sceneId, JSON.stringify(state)])
  const times = []
  let early = 0
  let before = picture()
  let still = 0
  for (let i = 0; i < FRAMES; i += 1) {
    times.push(render(`${name}, frame ${i + 1}`))
    if (i === 9) early = memoryUsed()
    const now = picture()
    if (i > 0 && changedPixels(before, now) === 0) still += 1
    before = now
  }
  // Grown by more than a frame buffer's worth while it ran: something is kept
  // every frame.
  const grown = memoryUsed() - early
  if (grown > WIDTH * HEIGHT * 2) fail(`${name}: memory grew ${grown} bytes between frame 10 and ${FRAMES}`)
  if (still > FRAMES / 4) fail(`${name}: ${still} of ${FRAMES} frames did not move`)
  const first = median(times.slice(5, 15))
  const last = median(times.slice(-10))
  if (last > first * 3 + 5) fail(`${name}: frames slowed from ${first.toFixed(1)} to ${last.toFixed(1)} ms`)
  if (last > FRAME_CEILING_MS) fail(`${name}: ${last.toFixed(1)} ms a frame`)
  report.push(`${name.padEnd(28)} ${last.toFixed(1).padStart(6)} ms  ${(memoryUsed() / 1048576).toFixed(2)} MiB`)
}

const pointer = (event, x, y, buttons) => {
  call('frameos_wasm_event', 'boolean', ['string', 'string'], [event, JSON.stringify({
    x: Math.round((x * WIRE_MAX) / (WIDTH - 1)),
    y: Math.round((y * WIRE_MAX) / (HEIGHT - 1)),
    pointerId: 1, pointerType: 'touch', button: 0, buttons,
  })])
}

const effects = toys.fields.find((field) => field.name === 'effect').options.map((option) => option.value)
for (const effect of effects) {
  play(`${effect}`, toys.id, { effect, quality: '0', showFps: false })
}
play('Hellfire, 4 px, fps', toys.id, { effect: 'fire', quality: '4', showFps: true })
const scenes = cycling.fields.find((field) => field.name === 'scene').options.map((option) => option.value)
for (const scene of scenes) {
  play(`color cycling: ${scene}`, cycling.id, { scene, quality: '0' })
}

// A swipe to the left is the next effect, and the next scene.
const swipeLeft = () => {
  pointer('pointerDown', 360, 200, 1)
  pointer('pointerMove', 240, 200, 1)
  pointer('pointerUp', 120, 200, 0)
  call('frameos_wasm_tick', 'boolean', [], [])
}
play('swipes', toys.id, { effect: effects[0], quality: '0', showFps: false })
swipeLeft()
render('after the swipe')
if (stateNow().effect !== effects[1]) fail(`a swipe left from ${effects[0]} showed ${stateNow().effect}, not ${effects[1]}`)
play('color cycling swipes', cycling.id, { scene: scenes[0], quality: '0' })
swipeLeft()
render('after the swipe')
if (stateNow().scene !== scenes[1]) fail(`a swipe left from ${scenes[0]} showed ${stateNow().scene}, not ${scenes[1]}`)

const peak = call('frameos_wasm_memory_peak', 'number', [], [])
console.log(report.join('\n'))
console.log(`ok: ${renders} renders, peak ${(peak / 1048576).toFixed(2)} of ${(limits.memoryBytes / 1048576).toFixed(2)} MiB`)
