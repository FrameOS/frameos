// Render one FrameOS scene frame to raw RGBA, headless, under Node.
//
// Used by the backend's ESP32 thin-client endpoint
// (app/utils/embedded_render.py): scenes for PSRAM-less boards render here —
// inside the same emscripten wasm runtime the browser live-preview uses —
// instead of on the device.
//
// Protocol: a single JSON object on stdin
//   {assetsDir, width, height, name, timeZone, settingsJson, scenesJson, sceneId}
// and exactly width*height*4 bytes of RGBA on stdout on success (exit 0).
// All logs go to stderr; any failure exits non-zero with a message there.
//
// Sandbox posture: user scene code (QuickJS) runs inside the wasm module.
// The runtime's only host hooks are logging and the synchronous-XHR HTTP
// bridge (tools/wasm/frameos_library.js) — Node has no XMLHttpRequest, so
// every outbound request from scene apps fails closed. Keep it that way:
// no XHR polyfill, no Module.frameosProxyUrl here. The wasm module has no
// filesystem or socket access of its own (plain MEMFS, no NODERAWFS).

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

// Defense in depth: the Python parent enforces the real timeout and kills
// us; this backstop covers a detached/orphaned harness.
const HARD_TIMEOUT_MS = 60_000
const killTimer = setTimeout(() => {
  process.stderr.write('embedded_wasm_render: hard timeout\n')
  process.exit(3)
}, HARD_TIMEOUT_MS)
killTimer.unref()

function fail(message) {
  process.stderr.write(`embedded_wasm_render: ${message}\n`)
  process.exit(1)
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

const request = JSON.parse(await readStdin())
const { assetsDir, width, height } = request
if (!assetsDir || !Number.isInteger(width) || !Number.isInteger(height)) {
  fail('assetsDir, width and height are required')
}

const wasmBinary = await readFile(join(assetsDir, 'frameos.wasm'))
const { default: createFrameOS } = await import(
  pathToFileURL(join(assetsDir, 'frameos.js')).href
)

const Module = await createFrameOS({
  wasmBinary,
  print: (line) => process.stderr.write(`[frameos] ${line}\n`),
  printErr: (line) => process.stderr.write(`[frameos] ${line}\n`),
  onFrameosLog: (line) => process.stderr.write(`[scene] ${line}\n`),
})

const call = (name, ret, argTypes, args) => Module.ccall(name, ret, argTypes, args)
const lastError = () => {
  try {
    return call('frameos_wasm_last_error', 'string', [], [])
  } catch (e) {
    return String(e)
  }
}

// Same init sequence as the live-preview worker (wasm/dist/assets/preview-worker.js).
const ok = call(
  'frameos_wasm_init',
  'boolean',
  ['number', 'number', 'string', 'string', 'string'],
  [width, height, request.name || 'thin client', request.timeZone || 'UTC', request.settingsJson || '{}']
)
if (!ok) fail(`init failed: ${lastError()}`)

const loaded = call('frameos_wasm_load_scenes', 'number', ['string'], [request.scenesJson || '[]'])
if (!loaded) fail(`no scenes loaded: ${lastError()}`)

if (request.sceneId) {
  if (!call('frameos_wasm_select_scene', 'boolean', ['string'], [request.sceneId])) {
    fail(`scene ${request.sceneId} not found: ${lastError()}`)
  }
}

const rc = call('frameos_wasm_render', 'number', [], [])
const outWidth = call('frameos_wasm_width', 'number', [], [])
const outHeight = call('frameos_wasm_height', 'number', [], [])
const ptr = call('frameos_wasm_buffer', 'number', [], [])
const len = call('frameos_wasm_buffer_len', 'number', [], [])
if (rc === 2 || !ptr || !len) fail(`render failed: ${lastError()}`)
if (len !== outWidth * outHeight * 4) {
  fail(`unexpected buffer size ${len} for ${outWidth}x${outHeight}`)
}

process.stdout.write(Buffer.from(Module.HEAPU8.buffer, ptr, len), (err) => {
  if (err) fail(`stdout write failed: ${err}`)
  process.exit(0)
})
