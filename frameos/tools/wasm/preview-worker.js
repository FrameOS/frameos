// FrameOS live-preview worker.
//
// Loads the emscripten-built scene runtime (frameos.js/frameos.wasm, built by
// frameos/tools/build_wasm.sh) and drives it for the frontend's live-preview
// modal. Runs in a Web Worker so the runtime's synchronous HTTP hook (sync
// XHR) is allowed and long renders never block the page.
//
// Messages in:
//   {type: 'init', width, height, timeZone, scenesJson, sceneId, settingsJson, proxyUrl,
//    fastMode?, saveAssets?, browserAssets?, deviceLimits?}
//     deviceLimits: {availableRenderBytes?, jsMemoryLimitMb?, jsMaxStackKb?,
//     maxHttpResponseBytes?} — simulate a constrained device (ESP32-class);
//     omit for the browser's own (unconstrained) limits.
//   {type: 'render'}                       force a render now
//   {type: 'event', name, payload}         dispatch a scene event
//   {type: 'selectScene', sceneId}
//   {type: 'setFastMode', enabled}         lift (or restore) the 1 fps throttle
//   {type: 'assets', requestId, op, ...}   browser asset folder ops, see handleAssetsRequest
// Messages out:
//   {type: 'ready', sceneInfo, browserAssets}
//   {type: 'frame', width, height, buffer, renderMs}   buffer: transferred ArrayBuffer (RGBA)
//   {type: 'state', state}
//   {type: 'log', message}
//   {type: 'sceneEvent', name, payload}
//   {type: 'error', message}
//   {type: 'fastRenderRequest', intervalMs}   the scene wants to render faster than the throttle allows
//   {type: 'assetsChanged'}                   files under /srv/assets changed (a scene wrote, or an op ran)
//   {type: 'assetsResult', requestId, ok, ...} reply to an 'assets' request
//
// Browser asset folder: the runtime's /srv/assets (the same path a real frame
// keeps its assets at) is an emscripten IDBFS mount — files live in this
// browser's IndexedDB, never on a frame or a server. Scenes read from it
// (local images, fonts, ...) and, with saveAssets on, write into it. A fresh
// folder is seeded with a few generated sample photos so image scenes have
// something to show. Falls back to a plain in-memory folder (nothing
// persists) where IndexedDB or the IDBFS export is unavailable.

let Module = null
let renderTimer = null
let rendering = false

// Render pacing. Every scene is throttled to at most one render per second:
// a scene asking for less (a 24 fps slideshow) gets a `fastRenderRequest`
// notice instead, and only renders that fast once the page opts in with
// setFastMode. Once per init so the page isn't nagged after declining.
const THROTTLE_MS = 1000
const FAST_MIN_MS = 10
const MAX_DELAY_MS = 15 * 60 * 1000
let fastMode = false
let fastRequestSent = false

const ASSETS_ROOT = '/srv/assets'
// Ceiling for the browser folder; a write past it fails instead of filling
// the IndexedDB quota with preview downloads.
const ASSETS_MAX_BYTES = 128 * 1024 * 1024
let assetsPersistent = false
let assetsMounted = false
// Cheap fingerprint of the folder after the last sync, so scene writes
// (saveAsset in apps) are detected and persisted without syncing IndexedDB
// on every render.
let assetsSignature = ''

function post(msg, transfer) {
  self.postMessage(msg, transfer || [])
}

function call(name, ret, argTypes, args) {
  return Module.ccall(name, ret, argTypes, args)
}

function lastError() {
  try {
    return call('frameos_wasm_last_error', 'string', [], [])
  } catch (e) {
    return String(e)
  }
}

function log(message) {
  post({ type: 'log', message })
}

// The scene's public state after a render/event; only posted when it
// differs from what the page already has (a fast scene renders many times a
// second without touching its state).
let lastPostedState = null
function postState(force) {
  try {
    const state = call('frameos_wasm_scene_state', 'string', [], [])
    if (!force && state === lastPostedState) {
      return
    }
    lastPostedState = state
    post({ type: 'state', state: JSON.parse(state) })
  } catch (e) {
    // state is informational; ignore
  }
}

// ------------------------------------------------------------------ assets

function fsEnsureDir(path) {
  const FS = Module.FS
  const parts = path.split('/').filter(Boolean)
  let current = ''
  for (const part of parts) {
    current += '/' + part
    try {
      FS.mkdir(current)
    } catch (e) {
      // exists
    }
  }
}

// A path from the page (or out of the wasm module) relative to the assets
// root, or null when it would escape it. Accepts "photos/a.jpg",
// "/photos/a.jpg" and the absolute "/srv/assets/photos/a.jpg".
function normalizeAssetPath(path) {
  let rel = String(path || '')
  if (rel === ASSETS_ROOT || rel.startsWith(ASSETS_ROOT + '/')) {
    rel = rel.slice(ASSETS_ROOT.length)
  }
  const parts = rel.split('/').filter((part) => part !== '')
  if (parts.some((part) => part === '.' || part === '..')) {
    return null
  }
  return parts.join('/')
}

function assetAbsolutePath(rel) {
  return rel ? ASSETS_ROOT + '/' + rel : ASSETS_ROOT
}

// Recursive listing of the folder: [{path, size, mtime, isDir}], paths
// relative to the root, files and folders alike, sorted by path.
function listAssetEntries() {
  const FS = Module.FS
  const entries = []
  const walk = (dir, relDir) => {
    let names
    try {
      names = FS.readdir(dir)
    } catch (e) {
      return
    }
    for (const name of names) {
      if (name === '.' || name === '..') continue
      const path = dir + '/' + name
      const rel = relDir ? relDir + '/' + name : name
      let stat
      try {
        stat = FS.stat(path)
      } catch (e) {
        continue
      }
      const mtime = stat.mtime instanceof Date ? stat.mtime.getTime() : Number(stat.mtime) || 0
      if (FS.isDir(stat.mode)) {
        entries.push({ path: rel, size: 0, mtime, isDir: true })
        walk(path, rel)
      } else if (FS.isFile(stat.mode)) {
        entries.push({ path: rel, size: stat.size, mtime, isDir: false })
      }
    }
  }
  walk(ASSETS_ROOT, '')
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return entries
}

function computeAssetsSignature() {
  return listAssetEntries()
    .map((entry) => entry.path + ':' + (entry.isDir ? 'd' : entry.size + ':' + entry.mtime))
    .join('\n')
}

function assetsTotalBytes() {
  let total = 0
  for (const entry of listAssetEntries()) {
    total += entry.size
  }
  return total
}

function syncAssets(populate) {
  return new Promise((resolve, reject) => {
    if (!assetsPersistent) {
      resolve()
      return
    }
    Module.FS.syncfs(populate, (err) => (err ? reject(err) : resolve()))
  })
}

// Persist the folder to IndexedDB (no-op for the in-memory fallback) and
// remember its fingerprint so the post-render check stays quiet until
// something actually changes.
async function persistAssets() {
  try {
    await syncAssets(false)
  } catch (e) {
    log('assets: could not persist the browser folder: ' + e)
  }
  assetsSignature = computeAssetsSignature()
}

// After a render: did the scene write into the folder (saveAsset in apps,
// a downloaded photo, an OpenAI image)? Then persist and tell the page.
async function persistAssetsIfChanged() {
  if (!assetsMounted) return
  let signature
  try {
    signature = computeAssetsSignature()
  } catch (e) {
    return
  }
  if (signature === assetsSignature) return
  await persistAssets()
  post({ type: 'assetsChanged' })
}

function removeAssetTree(absPath) {
  const FS = Module.FS
  const stat = FS.stat(absPath)
  if (FS.isDir(stat.mode)) {
    for (const name of FS.readdir(absPath)) {
      if (name === '.' || name === '..') continue
      removeAssetTree(absPath + '/' + name)
    }
    FS.rmdir(absPath)
  } else {
    FS.unlink(absPath)
  }
}

function clearAssets() {
  const FS = Module.FS
  for (const name of FS.readdir(ASSETS_ROOT)) {
    if (name === '.' || name === '..') continue
    removeAssetTree(ASSETS_ROOT + '/' + name)
  }
}

// --- starter images -------------------------------------------------------
// A brand-new folder gets a few generated "photos" (1600×1200 JPEGs) so
// slideshows and local-image scenes render something at once. Drawn with
// OffscreenCanvas; a browser without it just starts with an empty folder.

function makeRng(seed) {
  let state = seed >>> 0 || 1
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function paintHills(ctx, width, height, rng, layers, baseY, colors) {
  for (let layer = 0; layer < layers; layer++) {
    const amplitude = 40 + layer * 30
    const yBase = baseY + layer * (height * 0.09)
    const phase = rng() * Math.PI * 2
    const freq = 1.5 + rng() * 2
    ctx.fillStyle = colors[layer % colors.length]
    ctx.beginPath()
    ctx.moveTo(0, height)
    for (let x = 0; x <= width; x += 8) {
      const t = x / width
      const y =
        yBase +
        Math.sin(t * Math.PI * freq + phase) * amplitude +
        Math.sin(t * Math.PI * freq * 3.1 + phase * 1.7) * amplitude * 0.3
      ctx.lineTo(x, y)
    }
    ctx.lineTo(width, height)
    ctx.closePath()
    ctx.fill()
  }
}

function paintStarterImage(ctx, width, height, kind, rng) {
  if (kind === 'sunset') {
    const sky = ctx.createLinearGradient(0, 0, 0, height)
    sky.addColorStop(0, '#2b1a4e')
    sky.addColorStop(0.45, '#c2453f')
    sky.addColorStop(0.7, '#f39a4b')
    sky.addColorStop(1, '#fbd38d')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, width, height)
    const sunX = width * (0.3 + rng() * 0.4)
    const sunY = height * 0.58
    const glow = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, height * 0.35)
    glow.addColorStop(0, 'rgba(255, 240, 200, 0.9)')
    glow.addColorStop(1, 'rgba(255, 200, 120, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#fff3c4'
    ctx.beginPath()
    ctx.arc(sunX, sunY, height * 0.07, 0, Math.PI * 2)
    ctx.fill()
    paintHills(ctx, width, height, rng, 4, height * 0.6, ['#7a2f4a', '#4e1f3d', '#31142e', '#1c0b1e'])
  } else if (kind === 'night') {
    const sky = ctx.createLinearGradient(0, 0, 0, height)
    sky.addColorStop(0, '#050a1f')
    sky.addColorStop(0.6, '#0f1f4d')
    sky.addColorStop(1, '#1c3a6b')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, width, height)
    const stars = 350 + Math.floor(rng() * 200)
    for (let i = 0; i < stars; i++) {
      const x = rng() * width
      const y = rng() * height * 0.7
      const r = 0.5 + rng() * 1.8
      ctx.fillStyle = 'rgba(255,255,255,' + (0.3 + rng() * 0.7).toFixed(2) + ')'
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    const moonX = width * (0.6 + rng() * 0.25)
    const moonY = height * (0.18 + rng() * 0.15)
    ctx.fillStyle = '#f4f1de'
    ctx.beginPath()
    ctx.arc(moonX, moonY, height * 0.06, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#0f1f4d'
    ctx.beginPath()
    ctx.arc(moonX + height * 0.025, moonY - height * 0.015, height * 0.05, 0, Math.PI * 2)
    ctx.fill()
    paintHills(ctx, width, height, rng, 3, height * 0.68, ['#0b1730', '#070f22', '#03071a'])
  } else {
    const sky = ctx.createLinearGradient(0, 0, 0, height * 0.55)
    sky.addColorStop(0, '#3a8dde')
    sky.addColorStop(1, '#cfe9ff')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, width, height)
    const horizon = height * 0.55
    const sea = ctx.createLinearGradient(0, horizon, 0, height)
    sea.addColorStop(0, '#1c6fb8')
    sea.addColorStop(0.7, '#2a9bcf')
    sea.addColorStop(1, '#5fc8d8')
    ctx.fillStyle = sea
    ctx.fillRect(0, horizon, width, height - horizon)
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 2
    for (let i = 0; i < 26; i++) {
      const y = horizon + 20 + i * ((height - horizon) / 26)
      const phase = rng() * Math.PI * 2
      ctx.beginPath()
      for (let x = 0; x <= width; x += 10) {
        const wave = Math.sin(x / (60 + i * 8) + phase) * (2 + i * 0.6)
        if (x === 0) ctx.moveTo(x, y + wave)
        else ctx.lineTo(x, y + wave)
      }
      ctx.stroke()
    }
    const sand = ctx.createLinearGradient(0, height * 0.86, 0, height)
    sand.addColorStop(0, '#f1dfae')
    sand.addColorStop(1, '#d8bd7a')
    ctx.fillStyle = sand
    ctx.beginPath()
    ctx.moveTo(0, height)
    for (let x = 0; x <= width; x += 8) {
      ctx.lineTo(x, height * 0.88 + Math.sin(x / 140 + 1) * 14)
    }
    ctx.lineTo(width, height)
    ctx.closePath()
    ctx.fill()
    const clouds = 4 + Math.floor(rng() * 4)
    for (let i = 0; i < clouds; i++) {
      const cx = rng() * width
      const cy = height * (0.08 + rng() * 0.3)
      const size = 40 + rng() * 60
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      for (let puff = 0; puff < 5; puff++) {
        ctx.beginPath()
        ctx.arc(cx + (puff - 2) * size * 0.7, cy + (puff % 2) * size * 0.25, size * (0.6 + rng() * 0.4), 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  ctx.font = '600 28px system-ui, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  ctx.textAlign = 'right'
  ctx.fillText('FrameOS sample image · ' + kind, width - 32, height - 32)
}

async function seedStarterAssets() {
  if (typeof OffscreenCanvas === 'undefined') {
    log('assets: OffscreenCanvas unavailable; the browser folder starts empty')
    return
  }
  const seed = Math.floor(Math.random() * 0xffffffff)
  const width = 1600
  const height = 1200
  let written = 0
  for (const kind of ['sunset', 'ocean', 'night']) {
    try {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      paintStarterImage(ctx, width, height, kind, makeRng(seed ^ kind.length * 7919))
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      Module.FS.writeFile(assetAbsolutePath('sample-' + kind + '.jpg'), bytes)
      written += 1
    } catch (e) {
      log('assets: could not generate sample image ' + kind + ': ' + e)
    }
  }
  if (written > 0) {
    log('assets: generated ' + written + ' sample image(s) in the browser folder')
  }
}

// Mount the browser folder at /srv/assets. Called once per worker (after
// the module is created, before scenes load) so the first render already
// sees the files.
async function mountBrowserAssets(enabled) {
  const FS = Module.FS
  if (!FS) {
    log('assets: wasm bundle lacks the FS export; no browser asset folder')
    return
  }
  fsEnsureDir(ASSETS_ROOT)
  assetsMounted = true
  if (enabled === false) {
    return
  }
  if (Module.IDBFS && typeof indexedDB !== 'undefined') {
    try {
      FS.mount(Module.IDBFS, {}, ASSETS_ROOT)
      assetsPersistent = true
      await syncAssets(true)
    } catch (e) {
      assetsPersistent = false
      log('assets: browser storage unavailable (' + e + '); the folder lives in memory for this preview only')
    }
  } else {
    log('assets: persistent browser storage unavailable; the folder lives in memory for this preview only')
  }
  const entries = listAssetEntries()
  if (entries.length === 0) {
    await seedStarterAssets()
  }
  await persistAssets()
  const files = listAssetEntries().filter((entry) => !entry.isDir).length
  log(
    'assets: ' +
      ASSETS_ROOT +
      ' is a browser-only folder (' +
      files +
      ' file' +
      (files === 1 ? '' : 's') +
      (assetsPersistent ? ', kept in this browser between previews)' : ', in memory for this preview only)')
  )
}

function browserAssetsInfo() {
  return { mounted: assetsMounted, persistent: assetsPersistent, root: ASSETS_ROOT, maxBytes: ASSETS_MAX_BYTES }
}

// Browser folder ops from the page. Every request is answered with an
// `assetsResult` carrying its requestId; mutations persist first.
//   {op: 'list'}                       -> {entries}
//   {op: 'read', path}                 -> {data}   (ArrayBuffer, transferred)
//   {op: 'write', path, data}          (data: ArrayBuffer/typed array; creates folders)
//   {op: 'mkdir', path}
//   {op: 'delete', path}               (files and folders, recursive)
//   {op: 'reset'}                      wipe the folder and regenerate the samples
async function handleAssetsRequest(msg) {
  const requestId = msg.requestId
  const reply = (payload, transfer) => post({ type: 'assetsResult', requestId, ok: true, ...payload }, transfer)
  const fail = (error) => post({ type: 'assetsResult', requestId, ok: false, error: String(error) })
  if (!Module || !assetsMounted) {
    fail('browser asset folder is not available')
    return
  }
  const FS = Module.FS
  try {
    switch (msg.op) {
      case 'list':
        reply({ entries: listAssetEntries(), info: browserAssetsInfo() })
        return
      case 'read': {
        const rel = normalizeAssetPath(msg.path)
        if (!rel) throw new Error('invalid path')
        const bytes = FS.readFile(assetAbsolutePath(rel))
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        reply({ data }, [data])
        return
      }
      case 'write': {
        const rel = normalizeAssetPath(msg.path)
        if (!rel) throw new Error('invalid path')
        const bytes = msg.data instanceof ArrayBuffer ? new Uint8Array(msg.data) : new Uint8Array(msg.data || [])
        let existing = 0
        try {
          existing = FS.stat(assetAbsolutePath(rel)).size
        } catch (e) {
          // new file
        }
        if (assetsTotalBytes() - existing + bytes.length > ASSETS_MAX_BYTES) {
          throw new Error('the browser folder is limited to ' + Math.round(ASSETS_MAX_BYTES / 1024 / 1024) + ' MB')
        }
        const slash = rel.lastIndexOf('/')
        if (slash > 0) fsEnsureDir(assetAbsolutePath(rel.slice(0, slash)))
        FS.writeFile(assetAbsolutePath(rel), bytes)
        await persistAssets()
        post({ type: 'assetsChanged' })
        reply({})
        return
      }
      case 'mkdir': {
        const rel = normalizeAssetPath(msg.path)
        if (!rel) throw new Error('invalid path')
        fsEnsureDir(assetAbsolutePath(rel))
        await persistAssets()
        post({ type: 'assetsChanged' })
        reply({})
        return
      }
      case 'delete': {
        const rel = normalizeAssetPath(msg.path)
        if (!rel) throw new Error('invalid path')
        removeAssetTree(assetAbsolutePath(rel))
        await persistAssets()
        post({ type: 'assetsChanged' })
        reply({})
        return
      }
      case 'reset':
        clearAssets()
        await seedStarterAssets()
        await persistAssets()
        post({ type: 'assetsChanged' })
        reply({})
        return
      default:
        throw new Error('unknown assets op: ' + msg.op)
    }
  } catch (e) {
    fail(e && e.message ? e.message : e)
  }
}

// ----------------------------------------------------------------- render

function renderNow() {
  if (!Module || rendering) {
    return
  }
  rendering = true
  try {
    const started = Date.now()
    const rc = call('frameos_wasm_render', 'number', [], [])
    const width = call('frameos_wasm_width', 'number', [], [])
    const height = call('frameos_wasm_height', 'number', [], [])
    const ptr = call('frameos_wasm_buffer', 'number', [], [])
    const len = call('frameos_wasm_buffer_len', 'number', [], [])
    if (rc === 2 || !ptr || !len) {
      post({ type: 'error', message: 'render failed: ' + lastError() })
      return
    }
    // Copy out of the wasm heap; the buffer is transferred to the page.
    const buffer = Module.HEAPU8.buffer.slice(ptr, ptr + len)
    post({ type: 'frame', width, height, buffer, renderMs: Date.now() - started }, [buffer])
    postState()
  } catch (e) {
    post({ type: 'error', message: 'render crashed: ' + e })
  } finally {
    rendering = false
    void persistAssetsIfChanged()
    scheduleNextRender()
  }
}

// The delay before the next render for a scene that asked for `seconds`:
// throttled to one render per second unless fast mode is on, never longer
// than 15 minutes.
function renderDelayMs(seconds, fast) {
  const wanted = seconds * 1000
  const floor = fast ? FAST_MIN_MS : THROTTLE_MS
  return Math.min(Math.max(wanted, floor), MAX_DELAY_MS)
}

function scheduleNextRender() {
  if (!Module) {
    return
  }
  if (renderTimer) {
    clearTimeout(renderTimer)
    renderTimer = null
  }
  let seconds = 0
  try {
    const interval = call('frameos_wasm_scene_interval', 'number', [], [])
    const nextSleep = call('frameos_wasm_next_sleep', 'number', [], [])
    seconds = interval > 0 ? interval : 300
    if (nextSleep >= 0 && nextSleep < seconds) {
      seconds = nextSleep
    }
  } catch (e) {
    seconds = 300
  }
  if (!fastMode && seconds * 1000 < THROTTLE_MS && !fastRequestSent) {
    fastRequestSent = true
    post({ type: 'fastRenderRequest', intervalMs: Math.max(Math.round(seconds * 1000), FAST_MIN_MS) })
  }
  renderTimer = setTimeout(renderNow, renderDelayMs(seconds, fastMode))
}

function renderSoonIfRequested() {
  try {
    if (call('frameos_wasm_render_requested', 'boolean', [], [])) {
      renderNow()
    } else {
      postState()
    }
  } catch (e) {
    post({ type: 'error', message: String(e) })
  }
}

async function init(msg) {
  try {
    fastMode = Boolean(msg.fastMode)
    fastRequestSent = false
    const createFrameOS = (await import('./frameos.js')).default
    Module = await createFrameOS({
      locateFile: (path) => new URL(path, import.meta.url).href,
      onFrameosLog: (message) => post({ type: 'log', message }),
      onFrameosEvent: (name, payload) => {
        let parsed = {}
        try {
          parsed = JSON.parse(payload)
        } catch (e) {}
        post({ type: 'sceneEvent', name, payload: parsed })
      },
    })
    // Route the runtime's HTTP requests through the backend proxy (same-origin,
    // no CORS) so data apps that fetch external URLs work like on the device.
    if (msg.proxyUrl) {
      Module['frameosProxyUrl'] = msg.proxyUrl
    }

    await mountBrowserAssets(msg.browserAssets)

    const ok = call(
      'frameos_wasm_init',
      'boolean',
      ['number', 'number', 'string', 'string', 'string'],
      [
        msg.width,
        msg.height,
        msg.name || 'live preview',
        msg.timeZone || 'UTC',
        msg.settingsJson || '{}',
      ]
    )
    if (!ok) {
      throw new Error('init failed: ' + lastError())
    }
    // Device simulation: cap render memory / JS heap / HTTP responses the way
    // the chosen device would. Must land before scenes load so scene JS
    // contexts are created under the ceilings.
    if (msg.deviceLimits && typeof msg.deviceLimits === 'object') {
      try {
        call('frameos_wasm_set_device_limits', 'boolean', ['string'], [JSON.stringify(msg.deviceLimits)])
      } catch (e) {
        log('device simulation unavailable (older wasm bundle); previewing without limits')
      }
    }
    // Apps may save into the browser folder (a device's saveAssets setting;
    // on by default here — it's the visitor's own browser storage). Pass
    // `saveAssets: false` or a {nodeName: bool} map to mirror a frame.
    const saveAssets = msg.saveAssets === undefined ? true : msg.saveAssets
    try {
      call('frameos_wasm_set_save_assets', 'boolean', ['string'], [JSON.stringify(saveAssets)])
    } catch (e) {
      // older bundle without the export
    }
    const loaded = call('frameos_wasm_load_scenes', 'number', ['string'], [msg.scenesJson])
    if (!loaded) {
      throw new Error('no scenes loaded: ' + lastError())
    }
    if (msg.sceneId) {
      call('frameos_wasm_select_scene', 'boolean', ['string'], [msg.sceneId])
    }
    lastPostedState = null
    const sceneInfo = JSON.parse(call('frameos_wasm_scene_info', 'string', [], []))
    post({ type: 'ready', sceneInfo, browserAssets: browserAssetsInfo() })
    renderNow()
  } catch (e) {
    post({ type: 'error', message: String(e && e.message ? e.message : e) })
  }
}

self.onmessage = (ev) => {
  const msg = ev.data || {}
  switch (msg.type) {
    case 'init':
      init(msg)
      break
    case 'render':
      renderNow()
      break
    case 'event':
      if (Module) {
        try {
          call(
            'frameos_wasm_event',
            'boolean',
            ['string', 'string'],
            [msg.name, JSON.stringify(msg.payload || {})]
          )
        } catch (e) {
          post({ type: 'error', message: 'event failed: ' + e })
        }
        renderSoonIfRequested()
      }
      break
    case 'selectScene':
      if (Module) {
        call('frameos_wasm_select_scene', 'boolean', ['string'], [msg.sceneId])
        fastRequestSent = false
        renderNow()
      }
      break
    case 'setFastMode':
      fastMode = Boolean(msg.enabled)
      if (!fastMode) {
        // A later fast scene may ask again; this one already got its answer.
        fastRequestSent = true
      }
      if (Module && !rendering) {
        scheduleNextRender()
      }
      break
    case 'assets':
      void handleAssetsRequest(msg)
      break
    default:
      break
  }
}
