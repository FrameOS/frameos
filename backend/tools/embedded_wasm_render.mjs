// Render one FrameOS scene frame to raw RGBA, headless, under Node.
//
// Used by the backend's ESP32 thin-client endpoint
// (app/utils/embedded_render.py): scenes for PSRAM-less boards render here —
// inside the same emscripten wasm runtime the browser live-preview uses —
// instead of on the device.
//
// Protocol: a single JSON object on stdin
//   {assetsDir, width, height, name, timeZone, settingsJson, scenesJson,
//    sceneId, statesJson, frameAssetsRoot, saveAssetsJson, assetsWriteBudget}
// and exactly width*height*4 bytes of RGBA on stdout on success (exit 0).
// All logs go to stderr; any failure exits non-zero with a message there.
// statesJson ({sceneId: stateObject}) seeds backend-persisted scene state;
// after a successful render the post-render state is reported on stderr as
// one `__FRAMEOS_SCENE_STATE__{"sceneId":...,"state":...}` line, which the
// Python caller parses. frameAssetsRoot is a host directory whose files are
// preloaded into the wasm MEMFS under /srv/assets, so scene apps that read
// frame assets (photo folders etc.) see them like on-device files.
// saveAssetsJson carries the frame's saveAssets config into the runtime;
// files that apps save during the render (saveAsset in apps.nim — OpenAI
// images, downloaded photos) land in MEMFS and are written back to
// frameAssetsRoot after the render, up to assetsWriteBudget bytes (the
// frame's remaining asset quota), reported on stderr as one
// `__FRAMEOS_SAVED_ASSETS__{"files":[...],"skippedOverBudget":n}` line.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, join, relative, sep } from 'node:path'

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

// The corpus differential renders each scene with the planner on and off and
// compares the pixels; plans are built at scene init, so the toggle must land
// before the scene is selected.
if (request.disableFusion) {
  call('frameos_wasm_set_fusion', null, ['boolean'], [false])
}
const loaded = call('frameos_wasm_load_scenes', 'number', ['string'], [request.scenesJson || '[]'])
if (!loaded) fail(`no scenes loaded: ${lastError()}`)

if (request.sceneId) {
  if (!call('frameos_wasm_select_scene', 'boolean', ['string'], [request.sceneId])) {
    fail(`scene ${request.sceneId} not found: ${lastError()}`)
  }
}

// Seed backend-persisted scene state (virtual frames). Old wasm bundles
// predate the export; state seeding then degrades to defaults-only, and
// stateSeeded=false tells the backend NOT to persist the post-render
// readback (it would clobber the stored state with scene defaults).
let stateSeeded = true
if (request.statesJson) {
  let states = null
  try {
    states = JSON.parse(request.statesJson)
  } catch {
    stateSeeded = false
    process.stderr.write('embedded_wasm_render: invalid statesJson, ignoring\n')
  }
  if (states && typeof states === 'object') {
    for (const [sceneId, state] of Object.entries(states)) {
      if (!state || typeof state !== 'object') continue
      try {
        call('frameos_wasm_set_scene_state', 'boolean', ['string', 'string'],
          [sceneId, JSON.stringify(state)])
      } catch (error) {
        stateSeeded = false
        process.stderr.write(`embedded_wasm_render: state seeding unavailable (${error})\n`)
        break
      }
    }
  }
}

// The frame's saveAssets config, so apps' "auto" save mode matches the
// device. Old bundles predate the export; they keep saveAssets=false.
if (request.saveAssetsJson) {
  try {
    call('frameos_wasm_set_save_assets', 'boolean', ['string'], [request.saveAssetsJson])
  } catch (error) {
    process.stderr.write(`embedded_wasm_render: saveAssets config unavailable (${error})\n`)
  }
}

// Preload the frame's backend-stored assets into MEMFS so scene apps can
// read them at the on-device path. Needs a wasm bundle built with FS in
// EXPORTED_RUNTIME_METHODS; older bundles just skip the preload.
// `preloadedFiles` records what existed before the render, so the
// write-back below only copies files the scene created.
const MAX_PRELOAD_BYTES = 128 * 1024 * 1024
const MEMFS_ASSETS_ROOT = '/srv/assets'
const preloadedFiles = new Set()
if (request.frameAssetsRoot && Module.FS && existsSync(request.frameAssetsRoot)) {
  const FS = Module.FS
  const ensureDir = (path) => {
    const parts = path.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current += '/' + part
      try {
        FS.mkdir(current)
      } catch {
        // exists
      }
    }
  }
  let preloaded = 0
  let skipped = 0
  try {
    const entries = readdirSync(request.frameAssetsRoot, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      const hostPath = join(entry.parentPath ?? entry.path, entry.name)
      const rel = relative(request.frameAssetsRoot, hostPath).split(sep).join('/')
      if (!rel || rel.startsWith('..')) continue
      const target = MEMFS_ASSETS_ROOT + '/' + rel
      if (entry.isDirectory()) {
        ensureDir(target)
        continue
      }
      if (!entry.isFile()) continue
      const size = statSync(hostPath).size
      if (preloaded + size > MAX_PRELOAD_BYTES) {
        skipped += 1
        preloadedFiles.add(target) // over-cap files still must not be "new"
        continue
      }
      ensureDir(target.slice(0, target.lastIndexOf('/')))
      FS.writeFile(target, readFileSync(hostPath))
      preloadedFiles.add(target)
      preloaded += size
    }
  } catch (error) {
    process.stderr.write(`embedded_wasm_render: asset preload failed: ${error}\n`)
  }
  if (skipped > 0) {
    process.stderr.write(`embedded_wasm_render: skipped ${skipped} asset(s) over the ${MAX_PRELOAD_BYTES} byte preload cap\n`)
  }
} else if (request.frameAssetsRoot && !Module.FS) {
  process.stderr.write('embedded_wasm_render: wasm bundle lacks FS export, skipping asset preload\n')
}

// After the render: copy files the scene saved into MEMFS (saveAsset in
// apps.nim — OpenAI images, downloaded photos) back to the host asset
// store, within the remaining-quota budget the backend computed.
function writeBackSavedAssets() {
  if (!request.frameAssetsRoot || !Module.FS) return
  const FS = Module.FS
  const budget = Number.isFinite(request.assetsWriteBudget) ? request.assetsWriteBudget : 0
  const files = []
  let written = 0
  let skippedOverBudget = 0
  const walk = (dir) => {
    let names
    try {
      names = FS.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name === '.' || name === '..') continue
      const path = dir + '/' + name
      let stat
      try {
        stat = FS.stat(path)
      } catch {
        continue
      }
      if (FS.isDir(stat.mode)) {
        walk(path)
        continue
      }
      if (!FS.isFile(stat.mode) || preloadedFiles.has(path)) continue
      const rel = path.slice(MEMFS_ASSETS_ROOT.length + 1)
      // The path comes out of the wasm module; never let it escape the root.
      const parts = rel.split('/')
      if (parts.some((part) => !part || part === '.' || part === '..')) continue
      if (written + stat.size > budget) {
        skippedOverBudget += 1
        continue
      }
      try {
        const hostPath = join(request.frameAssetsRoot, ...parts)
        mkdirSync(dirname(hostPath), { recursive: true })
        writeFileSync(hostPath, FS.readFile(path))
        written += stat.size
        files.push(rel)
      } catch (error) {
        process.stderr.write(`embedded_wasm_render: asset write-back failed for ${rel}: ${error}\n`)
      }
    }
  }
  walk(MEMFS_ASSETS_ROOT)
  if (files.length > 0 || skippedOverBudget > 0) {
    process.stderr.write('__FRAMEOS_SAVED_ASSETS__' + JSON.stringify({ files, skippedOverBudget }) + '\n')
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

writeBackSavedAssets()

// Report the post-render scene state so the backend can persist what the
// scene changed. Best-effort: a failure here must not fail the render.
try {
  const info = JSON.parse(call('frameos_wasm_scene_info', 'string', [], []))
  const state = JSON.parse(call('frameos_wasm_scene_state', 'string', [], []))
  process.stderr.write('__FRAMEOS_SCENE_STATE__' + JSON.stringify({
    sceneId: info.currentSceneId || request.sceneId || '',
    state,
    seeded: stateSeeded,
  }) + '\n')
} catch (error) {
  process.stderr.write(`embedded_wasm_render: state readback failed: ${error}\n`)
}

process.stdout.write(Buffer.from(Module.HEAPU8.buffer, ptr, len), (err) => {
  if (err) fail(`stdout write failed: ${err}`)
  process.exit(0)
})
