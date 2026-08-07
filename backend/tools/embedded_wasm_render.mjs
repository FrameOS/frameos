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
// Sandbox posture: user scene code (QuickJS) runs inside the wasm module,
// never natively in Node. Its host hooks are logging and the synchronous
// XHR bridge (tools/wasm/frameos_library.js); the shim below implements
// that bridge so scene apps' HTTP works exactly like on a physical frame —
// the device fetches xkcd/weather/etc directly, and so does this. The one
// hard block is the cloud metadata address. The wasm module has no
// filesystem or socket access of its own (plain MEMFS, no NODERAWFS).

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

// Synchronous XMLHttpRequest, as the emscripten HTTP bridge expects: each
// send() runs fetch() in a short-lived child Node so the blocking wait is
// outside this process' event loop.
const FETCH_CHILD_SCRIPT = `
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const req = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs || 30000);
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.bodyBase64 ? Buffer.from(req.bodyBase64, 'base64') : undefined,
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = Buffer.from(await response.arrayBuffer());
    process.stdout.write(JSON.stringify({ status: response.status, bodyBase64: body.toString('base64') }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 0, error: String(error) }));
  }
});
`

class SyncXMLHttpRequest {
  open(method, url) {
    this._method = method
    this._url = url
    this._headers = {}
    this.status = 0
    this.response = null
    this.responseText = ''
  }
  setRequestHeader(name, value) {
    this._headers[name] = value
  }
  send(body) {
    if (/^https?:\/\/(\[?fd00:ec2::254\]?|169\.254\.169\.254)([:/]|$)/i.test(this._url)) {
      throw new Error('blocked: cloud metadata address')
    }
    const request = {
      method: this._method,
      url: this._url,
      headers: this._headers,
      timeoutMs: this.timeout || 30000,
      bodyBase64: body ? Buffer.from(body).toString('base64') : '',
    }
    const child = spawnSync(process.execPath, ['-e', FETCH_CHILD_SCRIPT], {
      input: JSON.stringify(request),
      maxBuffer: 32 * 1024 * 1024,
      timeout: (this.timeout || 30000) + 5000,
    })
    if (child.status !== 0 || !child.stdout) {
      throw new Error(`fetch child failed: ${child.stderr || child.status}`)
    }
    const result = JSON.parse(child.stdout.toString('utf-8'))
    if (result.status === 0) {
      throw new Error(result.error || 'request failed')
    }
    this.status = result.status
    const bytes = Buffer.from(result.bodyBase64 || '', 'base64')
    if (this.responseType === 'arraybuffer') {
      this.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    } else {
      this.responseText = bytes.toString('utf-8')
      this.response = this.responseText
    }
  }
}
globalThis.XMLHttpRequest = SyncXMLHttpRequest

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
