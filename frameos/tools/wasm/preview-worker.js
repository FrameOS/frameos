// FrameOS live-preview worker.
//
// Loads the emscripten-built scene runtime (frameos.js/frameos.wasm, built by
// frameos/tools/build_wasm.sh) and drives it for the frontend's live-preview
// modal. Runs in a Web Worker so the runtime's synchronous HTTP hook (sync
// XHR) is allowed and long renders never block the page.
//
// Messages in:
//   {type: 'init', width, height, timeZone, scenesJson, sceneId, settingsJson, proxyUrl, proxyFirst?,
//    fastMode?, saveAssets?, browserAssets?, lanAccess?, sceneState?, renderScale?, windowed?, framePage?}
//        proxyFirst: send the scene's requests through `proxyUrl` without trying the browser first (a
//        self-hosted backend's proxy, which reaches what the frame reaches). Otherwise the browser goes
//        first and an origin it fails on goes through the proxy from then on.
//        windowed: run the scenes side by side, as a Pi does (docs/scene-layouts.md "Windows").
//        framePage: offer the frame's own page in the scene settings (docs/scene-settings.md); its
//        Restart and Reboot come out as `sceneEvent`s `restart` / `reboot`, a new scale as `frameSettings`.
//        sceneState: public field values for the scene it starts on, set before the first render
//        (`sceneStateSeeded` in `ready` says they were; an older bundle leaves that false).
//        fileTransfer: the page answers `fileRequest`s (a file picker, a download), so the Files scene shows
//        Upload and Download (frameos/file_transfer_preview.nim). `ready`'s `fileTransfer` says the bundle took it.
//        lanAccess: the previewed cloud frame's local network access (docs/lan-access.md); `false` makes the
//        runtime refuse private hosts the way that frame would. Absent = nothing to copy, nothing refused.
//   {type: 'render'}                       force a render now
//   {type: 'event', name, payload}         dispatch a scene event. Pointer input is three of them, shaped the way
//                                          frameos/src/drivers/evdev sends it on a frame: 'mouseMove' {x, y} with
//                                          both axes 0..32767 across the picture, 'mouseDown' / 'mouseUp' {button}
//                                          (0 left or touch, 1 right, 2 middle). The runtime hands the scene its own
//                                          pixel coordinates, like the runner does, and renders only when the scene
//                                          asks for it.
//   {type: 'selectScene', sceneId}
//   {type: 'setFastMode', enabled}         lift (or restore) the 1 fps throttle
//   {type: 'setRenderScale', scale}        the frame's render scale (0 = automatic), drawn at once
//   {type: 'resize', width, height}        a new size, everything kept and drawn again (`ready`'s `resize` says
//                                          the bundle can; otherwise init again)
//   {type: 'assets', requestId, op, ...}   browser asset folder ops, see handleAssetsRequest
//   {type: 'clipboard', text}              the browser's clipboard, for the frame's next Paste (docs/jsx-ui.md
//                                          "Selecting, copying and pasting"); a bundle without it ignores it
//   {type: 'fileUpload', id, files}        the files the person picked for the Files scene's Upload: [{name, data}]
//                                          (data an ArrayBuffer), written into the folder request `id` named
//   {type: 'fileTransferDone', id, ok, error?}  the page's end of request `id` without files: a download saved
//                                          (ok), or the picker or the save given up (error 'cancelled')
// Messages out:
//   {type: 'ready', sceneInfo, sceneStateSeeded, browserAssets, runtimeVersion, pointerEvents, inputEvents, gpioEvents,
//    clipboard}
//        runtimeVersion: FrameOS version of the bundle (null on older bundles)
//        pointerEvents: true when this bundle takes pointer input as described above. A bundle without it would hand
//        the scene raw 0..32767 coordinates and render on every move, so a page must not forward pointers to it.
//        gpioEvents: true when a held button is sent as its `gpio` edges, `down` and `up`. A bundle without it
//        gets one `button` for the whole press.
//        cursor: true when this bundle says what the mouse cursor looks like (the `cursor` messages below).
//   {type: 'frame', width, height, buffer, renderMs}   buffer: transferred ArrayBuffer (RGBA)
//   {type: 'state', state}
//   {type: 'sceneInfo', sceneInfo}           the runtime changed scenes by itself (a scene's setCurrentScene, the
//                                            switcher, a store preview) or its scene list: same shape as in `ready`
//   {type: 'log', message}
//   {type: 'sceneEvent', name, payload}
//   {type: 'error', message}
//   {type: 'fastRenderRequest', intervalMs}   the scene wants to render faster than the throttle allows
//   {type: 'assetsChanged'}                   files under /srv/assets changed (a scene wrote, or an op ran)
//   {type: 'cursor', shape, sprite}           the mouse cursor over the picture changed: `shape` as CSS names it
//                                            (what the UI under the pointer asks for, docs/jsx-ui.md "The mouse
//                                            cursor"), `sprite` the frame's picture of it at this size ({width, height,
//                                            hotX, hotY, pixels, scale, hideMs}; null for "none")
//   {type: 'assetsResult', requestId, ok, ...} reply to an 'assets' request
//   {type: 'clipboard', text}                 a Copy or a Cut in a JSX field: for the browser's clipboard
//   {type: 'fileRequest', id, op, name, data?} the Files scene asks the page: op 'upload' (pick files from the
//                                            computer for the folder `name`, answered with `fileUpload`) or
//                                            'download' (save `data`, an ArrayBuffer, as `name`, answered with
//                                            `fileTransferDone`). A new request replaces one still waiting.
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

// What a caught error says: a wasm trap or an emscripten exception is an
// object whose `+ e` is "[object Object]", which told nobody anything.
function errorText(e) {
  if (e && typeof e === 'object') {
    if (typeof e.message === 'string' && e.message) {
      return e.message
    }
    if (e.name) {
      return String(e.name)
    }
    try {
      const json = JSON.stringify(e)
      if (json && json !== '{}') {
        return json
      }
    } catch (_) {
      // a cycle: fall through
    }
  }
  return String(e)
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

// The scene showing and the scenes loaded, posted when the runtime changed
// them itself (the page's own selectScene is known to it already, and posting
// it again does no harm): the page's scene select and form follow.
let lastSceneInfoKey = null
function sceneInfoKey(info) {
  return (info.currentSceneId || '') + '|' + (info.scenes || []).map((scene) => scene.id).join(',')
}
function postSceneInfo() {
  try {
    const info = JSON.parse(call('frameos_wasm_scene_info', 'string', [], []))
    const key = sceneInfoKey(info)
    if (key === lastSceneInfoKey) {
      return
    }
    lastSceneInfoKey = key
    post({ type: 'sceneInfo', sceneInfo: info })
  } catch (e) {
    // informational, like the state
  }
}

// The mouse cursor's shape under the page's pointer, posted when it changes
// (a move onto a window's edge, a render that put a button under a still
// mouse), with the frame's picture of it at the frame's size for a page that
// draws the frame's cursor (frameos_wasm_cursor, frameos_wasm_cursor_sprite).
let lastCursorKey = null
let frameSize = ''
function postCursor() {
  if (!Module || typeof Module._frameos_wasm_cursor !== 'function') {
    return
  }
  try {
    const shape = call('frameos_wasm_cursor', 'string', [], [])
    const key = shape + '@' + frameSize
    if (key === lastCursorKey) {
      return
    }
    lastCursorKey = key
    const text = call('frameos_wasm_cursor_sprite', 'string', ['string'], [shape])
    post({ type: 'cursor', shape, sprite: text ? JSON.parse(text) : null })
  } catch (e) {
    // informational, like the state
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

// ------------------------------------------- files to and from the computer

// Upload and Download in the Files scene (frameos/file_transfer_preview.nim).
// The runtime asks while the scene's tap runs (onFrameosFileRequest); the
// request goes to the page, because a file picker and a download start from a
// person's gesture and only the page has one. The page answers with the files
// picked (`fileUpload`, written here into the folder the runtime named, never
// one the page names) or with `fileTransferDone`, and the runtime draws the
// scene that asked again. One request at a time: a new one replaces another
// still waiting, in the runtime too.
let fileTransferOn = false
const fileRequests = new Map() // id -> {op, path}

function onFileRequest(text) {
  let request = null
  try {
    request = JSON.parse(text)
  } catch (e) {
    return
  }
  // Out of the runtime's call first: the answer goes back into it.
  setTimeout(() => startFileRequest(request), 0)
}

// A path the runtime named, relative to the assets root, or null for one
// outside it.
function assetPathFromRuntime(path) {
  const text = String(path || '')
  if (text !== ASSETS_ROOT && !text.startsWith(ASSETS_ROOT + '/')) {
    return null
  }
  return normalizeAssetPath(text)
}

function baseNameOf(rel) {
  return rel.slice(rel.lastIndexOf('/') + 1)
}

function startFileRequest(request) {
  const id = Number(request && request.id) || 0
  const rel = assetPathFromRuntime(request && request.path)
  fileRequests.clear()
  if (!id || rel === null || !assetsMounted) {
    finishFileRequest(id, false, 0, 'failed')
    return
  }
  if (request.op === 'download') {
    let data
    try {
      const bytes = Module.FS.readFile(assetAbsolutePath(rel))
      data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    } catch (e) {
      finishFileRequest(id, false, 0, 'failed')
      return
    }
    fileRequests.set(id, { op: 'download', path: rel })
    post({ type: 'fileRequest', id, op: 'download', name: baseNameOf(rel), data }, [data])
  } else if (request.op === 'upload') {
    fileRequests.set(id, { op: 'upload', path: rel })
    post({ type: 'fileRequest', id, op: 'upload', name: rel ? baseNameOf(rel) : '' })
  } else {
    finishFileRequest(id, false, 0, 'failed')
  }
}

// A picked file's name as a name in the folder: no folders, no control
// characters, no dot first (the listing hides those), not too long.
function cleanFileName(name) {
  let clean = String(name || '')
  clean = clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1)
  clean = clean.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^[.\s]+/, '').trim()
  if (clean.length > 120) {
    const dot = clean.lastIndexOf('.')
    const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : ''
    clean = clean.slice(0, 120 - ext.length) + ext
  }
  return clean || 'file'
}

function pathExists(path) {
  try {
    Module.FS.stat(path)
    return true
  } catch (e) {
    return false
  }
}

// `name` in `dir`, or "name (2).jpg" and on when that is taken: an upload
// never replaces a file that is there.
function freeFileName(dir, name) {
  if (!pathExists(dir + '/' + name)) {
    return name
  }
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 1000; n++) {
    const next = stem + ' (' + n + ')' + ext
    if (!pathExists(dir + '/' + next)) {
      return next
    }
  }
  return null
}

async function handleFileUpload(msg) {
  const id = Number(msg.id) || 0
  const request = fileRequests.get(id)
  if (!request || request.op !== 'upload') {
    return
  }
  fileRequests.delete(id)
  const files = Array.isArray(msg.files) ? msg.files : []
  let count = 0
  let error = files.length === 0 ? 'cancelled' : ''
  try {
    const dir = assetAbsolutePath(request.path)
    fsEnsureDir(dir)
    let total = assetsTotalBytes()
    for (const file of files) {
      // Any realm's ArrayBuffer (a page's, a test's): Uint8Array reads its bytes.
      const bytes = file && file.data && typeof file.data.byteLength === 'number' ? new Uint8Array(file.data) : new Uint8Array(0)
      if (total + bytes.length > ASSETS_MAX_BYTES) {
        error = 'too_big'
        break
      }
      const name = freeFileName(dir, cleanFileName(file && file.name))
      if (!name) {
        error = 'failed'
        continue
      }
      Module.FS.writeFile(dir + '/' + name, bytes)
      total += bytes.length
      count++
    }
  } catch (e) {
    log('assets: an upload failed: ' + errorText(e))
    error = 'failed'
  }
  if (count > 0) {
    await persistAssets()
    post({ type: 'assetsChanged' })
  }
  finishFileRequest(id, count > 0, count, error)
}

function handleFileTransferDone(msg) {
  const id = Number(msg.id) || 0
  const request = fileRequests.get(id)
  if (!request) {
    return
  }
  fileRequests.delete(id)
  const ok = msg.ok === true && request.op === 'download'
  finishFileRequest(id, ok, ok ? 1 : 0, ok ? '' : String(msg.error || 'cancelled'))
}

function finishFileRequest(id, ok, count, error) {
  if (!Module || outOfMemory || typeof Module._frameos_wasm_file_transfer_done !== 'function') {
    return
  }
  try {
    call('frameos_wasm_file_transfer_done', 'boolean', ['number', 'boolean', 'number', 'string'], [
      id,
      ok,
      count,
      error || '',
    ])
  } catch (e) {
    post({ type: 'error', message: 'file transfer failed: ' + errorText(e) })
  }
  renderSoonIfRequested()
}

// ------------------------------------------------- simulated device memory

// The runtime returns 3 from a render whose allocation was refused under the
// simulated ceiling. The longjmp that gets it out abandons the Nim stack, so
// whatever the render held is leaked — exactly as on a device, where the same
// guard is followed by a reboot. Report it, then stop: the page re-inits the
// worker to get a clean heap back.
const RENDER_OUT_OF_MEMORY = 3

let deviceLimits = null
let outOfMemory = false

function applyDeviceLimits(limits) {
  deviceLimits = limits || null
  if (!limits) {
    return
  }
  try {
    call('frameos_wasm_set_memory_limit', null, ['number', 'number'], [
      Math.max(0, Math.floor(limits.memoryBytes || 0)),
      Math.max(0, Math.floor(limits.memoryReserveBytes || 0)),
    ])
  } catch (e) {
    // older bundle without the export: run unsimulated rather than fail
    post({ type: 'log', message: 'device simulation unavailable in this runtime build' })
    deviceLimits = null
  }
}

// The frame's render scale (frame.json renderScale): what a .tsx app's JSX is
// laid out for. 0 or none is automatic from the preview's size, as on the frame.
function applyRenderScale(scale, force) {
  if (!force && !(typeof scale === 'number' && scale > 0)) {
    return
  }
  try {
    call('frameos_wasm_set_render_scale', null, ['number'], [scale])
  } catch (e) {
    // older bundle without the export: the automatic scale
    post({ type: 'log', message: 'a render scale is unavailable in this runtime build' })
  }
}

// Run as an ESP32 (memory.runsAsEmbedded in the runtime): `app.frame.embedded`
// is true, downloads decode into the canvas, and a JS app's interpreter stays
// between renders while the simulated memory has room, as on an awake ESP32. The device picker's ESP32 presets ask for it, and so
// does a preview of an ESP32 frame; anything else runs as a Pi.
function applyEmbedded(enabled) {
  if (!enabled) {
    return
  }
  try {
    call('frameos_wasm_set_embedded', null, ['boolean'], [true])
  } catch (e) {
    // older bundle without the export
    post({ type: 'log', message: 'running as an ESP32 is unavailable in this runtime build' })
    return
  }
  // The canvas the simulated device keeps (565 on a 13.3" colour panel with
  // 8 MB, luma on a grey one): one for every render, as the frame draws. An
  // older bundle draws a fresh RGBX canvas, which the ceiling allows for.
  const bytesPerPixel = deviceLimits && deviceLimits.canvasBytesPerPixel
  if (bytesPerPixel) {
    try {
      call('frameos_wasm_set_canvas_bits_per_pixel', null, ['number'], [bytesPerPixel * 8])
    } catch (e) {
      // older bundle without the export
    }
  }
}

function memoryStat(name) {
  try {
    return call(name, 'number', [], [])
  } catch (e) {
    return 0
  }
}

function postMemory(refusedBytes) {
  if (!deviceLimits) {
    return
  }
  post({
    type: 'memory',
    limitBytes: memoryStat('frameos_wasm_memory_limit'),
    usedBytes: memoryStat('frameos_wasm_memory_used'),
    peakBytes: memoryStat('frameos_wasm_memory_peak'),
    refusedBytes: refusedBytes || 0,
  })
}

// ----------------------------------------------------------------- render

function renderNow() {
  if (!Module || rendering || outOfMemory) {
    return
  }
  rendering = true
  try {
    const started = Date.now()
    const rc = call('frameos_wasm_render', 'number', [], [])
    if (rc === RENDER_OUT_OF_MEMORY) {
      outOfMemory = true
      const refused = memoryStat('frameos_wasm_memory_failed')
      postMemory(refused)
      post({
        type: 'outOfMemory',
        refusedBytes: refused,
        limitBytes: memoryStat('frameos_wasm_memory_limit'),
        usedBytes: memoryStat('frameos_wasm_memory_used'),
        peakBytes: memoryStat('frameos_wasm_memory_peak'),
      })
      return
    }
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
    frameSize = width + 'x' + height
    postSceneInfo()
    postState()
    postCursor()
    postMemory(0)
  } catch (e) {
    post({ type: 'error', message: 'render crashed: ' + errorText(e) })
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
  if (!Module || outOfMemory) {
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
    post({ type: 'error', message: errorText(e) })
  }
}

// The FrameOS version this bundle was built from ("2026.9.0"), or null for a
// bundle from before the export existed. The cloud installs the bundle from
// a release rather than building it, so this is how the preview can say
// which interpreter it is.
function runtimeVersion() {
  try {
    const version = call('frameos_wasm_version', 'string', [], [])
    return version && version !== 'unknown' ? version : null
  } catch (e) {
    return null
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
      // A tapped link (docs/jsx-ui.md "Links"): the page opens it in a tab.
      onFrameosOpenLink: (url) => post({ type: 'openLink', url: String(url) }),
      // Upload / Download in the Files scene: handed to the page (below).
      onFrameosFileRequest: (text) => onFileRequest(text),
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
      if (msg.proxyFirst === true) {
        Module['frameosProxyFirst'] = true
      }
    }
    if (msg.lanAccess === false) {
      Module['frameosLanAccess'] = false
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
    // Simulate a device's memory ceiling, if one was asked for. Set after
    // init on purpose: module startup (the baked-in font tables and friends)
    // lives in a frame's flash, not in its render budget.
    applyDeviceLimits(msg.deviceLimits)
    applyEmbedded(msg.embedded === true || Boolean(msg.deviceLimits && msg.deviceLimits.embedded))
    applyRenderScale(msg.renderScale)
    // The Scene store app may browse the store and preview its scenes here
    // (frameos/scene_store_preview.nim); installing stays a frame's. Only
    // this worker turns it on: a plane's renders are a fresh runtime each.
    try {
      call('frameos_wasm_set_store_preview', 'boolean', ['string'], [msg.storeUrl || 'https://cloud.frameos.net'])
    } catch (e) {
      // older bundle without the export: the app browses on its own
    }
    // Every frame is shown as it comes, so an <img src> page's pictures come
    // one a render, the next soon, rather than a first frame that waits for
    // all of them (a plane's render waits: it is the one picture a board gets).
    try {
      call('frameos_wasm_set_pictures_one_a_render', null, ['boolean'], [true])
    } catch (e) {
      // older bundle without the export
    }
    // Run the scenes side by side, as a Pi does (docs/scene-layouts.md
    // "Windows"): a layout's app.frame.scenes and its <Scene id> windows.
    if (msg.windowed) {
      try {
        call('frameos_wasm_set_windowed', null, ['boolean'], [true])
      } catch (e) {
        post({ type: 'log', message: 'windows are unavailable in this runtime build' })
      }
    }
    // The frame's own page in the scene settings (a layout's Control Panel), for
    // a page that is a frame of its own rather than an editor's preview. Its
    // Restart and Reboot reach the page as `sceneEvent`s, a new scale as a
    // `frameSettings` one.
    if (msg.framePage) {
      try {
        call('frameos_wasm_set_frame_page', null, ['boolean'], [true])
      } catch (e) {
        post({ type: 'log', message: 'the frame page is unavailable in this runtime build' })
      }
    }
    // Upload and Download in the Files scene, for a page that opens a file
    // picker and saves a file when asked (`fileRequest` below). A bundle
    // without the export shows neither.
    fileTransferOn = false
    fileRequests.clear()
    if (msg.fileTransfer === true && typeof Module._frameos_wasm_set_file_transfer === 'function') {
      call('frameos_wasm_set_file_transfer', null, ['boolean'], [true])
      fileTransferOn = true
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
    lastCursorKey = null
    const sceneInfo = JSON.parse(call('frameos_wasm_scene_info', 'string', [], []))
    lastSceneInfoKey = sceneInfoKey(sceneInfo)
    // Values the page keeps across a reboot (a Resize, an edit, Restart):
    // given to the scene before its first render, so that render draws them
    // rather than the scene's defaults with the page's values one render
    // later (a second request, for a scene that pays per render).
    let sceneStateSeeded = false
    if (msg.sceneState && typeof msg.sceneState === 'object' && Object.keys(msg.sceneState).length > 0) {
      const target = sceneInfo && sceneInfo.currentSceneId
      if (target) {
        try {
          sceneStateSeeded = call('frameos_wasm_set_scene_state', 'boolean', ['string', 'string'], [
            target,
            JSON.stringify(msg.sceneState),
          ])
        } catch (e) {
          // older bundle without the export: the page sends them after ready
        }
      }
    }
    post({
      type: 'ready',
      sceneInfo,
      sceneStateSeeded,
      browserAssets: browserAssetsInfo(),
      runtimeVersion: runtimeVersion(),
      pointerEvents: true,
      // Input v2 (2026.9.23): pointer events with a position, the wheel, the
      // keyboard, and the runtime's own gestures and long presses.
      inputEvents: typeof Module._frameos_wasm_tick === 'function',
      // Buttons as two events (2026.10.16): a `gpio` with `level` and
      // `action: 'down'` / `'up'` is an edge the runtime holds and times into
      // a `button` press, doublePress or longPress, each key by its pin and label.
      gpioEvents: true,
      resize: typeof Module._frameos_wasm_resize === 'function',
      cursor: typeof Module._frameos_wasm_cursor === 'function',
      // The frame's clipboard is the browser's (2026.11.11): 'clipboard' in and out.
      clipboard: hasClipboard(),
      // Upload and Download in the Files scene (2026.11.14): `fileRequest` out, `fileUpload` and
      // `fileTransferDone` in.
      fileTransfer: fileTransferOn,
    })
    clipboardChanges = hasClipboard() ? call('frameos_wasm_clipboard_changes', 'number', [], []) : -1
    renderNow()
  } catch (e) {
    post({ type: 'error', message: String(e && e.message ? e.message : e) })
  }
}

// ----------------------------------------------------------------- events

// The frame's clipboard as last handed on: a Copy or a Cut moves its count
// of changes, and the page gets the text for the browser's clipboard.
let clipboardChanges = -1

function hasClipboard() {
  return Boolean(Module && typeof Module._frameos_wasm_clipboard_changes === 'function')
}

function postClipboardIfChanged() {
  if (!hasClipboard()) {
    return
  }
  const changes = call('frameos_wasm_clipboard_changes', 'number', [], [])
  if (clipboardChanges < 0) {
    clipboardChanges = changes
  } else if (changes !== clipboardChanges) {
    clipboardChanges = changes
    post({ type: 'clipboard', text: call('frameos_wasm_clipboard', 'string', [], []) })
  }
}

function setClipboard(text) {
  if (!hasClipboard()) {
    return
  }
  call('frameos_wasm_set_clipboard', null, ['string'], [String(text || '')])
  // The browser's own text: nothing to hand back.
  clipboardChanges = call('frameos_wasm_clipboard_changes', 'number', [], [])
}

function dispatchEvent(name, payload) {
  if (!Module || outOfMemory) {
    return
  }
  try {
    call('frameos_wasm_event', 'boolean', ['string', 'string'], [name, JSON.stringify(payload || {})])
    postClipboardIfChanged()
  } catch (e) {
    post({ type: 'error', message: 'event failed: ' + errorText(e) })
  }
  renderSoonIfRequested()
}

// A drag posts a move per animation frame, and they pile up behind a render
// that takes longer than that. Replaying each one is pointless, so only the
// newest of a burst reaches the scene, per pointer (two fingers each keep
// theirs) — what the dispatcher does with the moves a frame's evdev thread
// queued. A move is held for one turn of the event loop (the queued messages
// behind it arrive first) and flushed ahead of any other event, so a press
// still lands where the pointer is.
const pendingMoves = new Map()
let pendingMoveTimer = null

function flushPendingMoves() {
  if (pendingMoveTimer) {
    clearTimeout(pendingMoveTimer)
    pendingMoveTimer = null
  }
  const moved = pendingMoves.size > 0
  for (const [name, payload] of pendingMoves.values()) {
    dispatchEvent(name, payload)
  }
  pendingMoves.clear()
  if (moved) {
    postCursor()
  }
}

// While a pointer or a GPIO button is held, or a button press waits out its
// double-press window, the runtime is ticked so a long press is delivered while
// the finger is still down and the press once the window closes, as on a frame
// (frameos_wasm_tick; frameos_wasm_pointers_down counts all three).
let tickTimer = null

function tickWhileHeld() {
  if (!Module || outOfMemory || typeof Module._frameos_wasm_tick !== 'function') {
    return
  }
  try {
    if (call('frameos_wasm_tick', 'boolean', [], [])) {
      renderSoonIfRequested()
    }
    if (call('frameos_wasm_pointers_down', 'number', [], []) <= 0) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  } catch (e) {
    post({ type: 'error', message: 'tick failed: ' + errorText(e) })
    clearInterval(tickTimer)
    tickTimer = null
  }
}

function handleEvent(name, payload) {
  if (name === 'mouseMove' || name === 'pointerMove') {
    const pointerId = payload && typeof payload.pointerId === 'number' ? payload.pointerId : 0
    pendingMoves.set(pointerId, [name, payload || {}])
    if (!pendingMoveTimer) {
      pendingMoveTimer = setTimeout(flushPendingMoves, 0)
    }
    return
  }
  flushPendingMoves()
  dispatchEvent(name, payload)
  if (name === 'pointerDown' || name === 'pointerUp' || name === 'pointerCancel') {
    // A press held keeps its element's cursor; its release gives it back.
    postCursor()
  }
  if ((name === 'pointerDown' || name === 'mouseDown' || name === 'button') && tickTimer === null && Module &&
      typeof Module._frameos_wasm_tick === 'function') {
    tickTimer = setInterval(tickWhileHeld, 50)
  }
}

// What calls into the runtime. After a render ran out of the simulated
// memory (renderNow) the runtime was left mid-render and nothing goes into it
// again: the page makes a new worker to start over. Clicks went on into it
// and each came back as "event failed".
const RUNTIME_MESSAGES = new Set([
  'render',
  'event',
  'selectScene',
  'resize',
  'chooseLayout',
  'setRenderScale',
  'clipboard',
  'fileUpload',
  'fileTransferDone',
])

self.onmessage = (ev) => {
  const msg = ev.data || {}
  if (outOfMemory && RUNTIME_MESSAGES.has(msg.type)) {
    return
  }
  switch (msg.type) {
    case 'init':
      init(msg)
      break
    case 'render':
      renderNow()
      break
    case 'event':
      handleEvent(msg.name, msg.payload)
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
    case 'resize':
      if (Module && typeof Module._frameos_wasm_resize === 'function') {
        call('frameos_wasm_resize', 'boolean', ['number', 'number'], [msg.width, msg.height])
        renderNow()
      }
      break
    case 'chooseLayout':
      // The layout every scene wears, as the frame's settings page chooses it:
      // the scenes and their windows stay as they are.
      if (Module && typeof Module._frameos_wasm_choose_layout === 'function') {
        call('frameos_wasm_choose_layout', 'boolean', ['string'], [String(msg.layoutId || '')])
        renderNow()
      }
      break
    case 'setRenderScale':
      // A new render scale (0 = automatic), drawn at once.
      if (Module) {
        applyRenderScale(Number(msg.scale) || 0, true)
        // A `render` from outside redraws every panel and window, laid out anew.
        dispatchEvent('render', {})
      }
      break
    case 'assets':
      void handleAssetsRequest(msg)
      break
    case 'clipboard':
      setClipboard(msg.text)
      break
    case 'fileUpload':
      void handleFileUpload(msg)
      break
    case 'fileTransferDone':
      handleFileTransferDone(msg)
      break
    case 'runAppTests':
      handleRunAppTests(msg)
      break
    default:
      break
  }
}

// {type: 'runAppTests', requestId, appJson, testFile} -> {type: 'appTestsResult',
// requestId, ok, report | error}: one test file of a JavaScript app, run in
// this runtime's interpreter (src/frameos/js_runtime/app_tests.nim). Needs the
// init that loaded the scenes; the tests see the frame it was given.
function handleRunAppTests(msg) {
  const requestId = msg.requestId
  if (!Module) {
    post({ type: 'appTestsResult', requestId, ok: false, error: 'the preview runtime is not running' })
    return
  }
  if (typeof Module._frameos_wasm_run_app_tests !== 'function') {
    post({
      type: 'appTestsResult',
      requestId,
      ok: false,
      error: 'This FrameOS runtime bundle cannot run app tests; it needs FrameOS 2026.10.16 or newer.',
    })
    return
  }
  try {
    const text = call('frameos_wasm_run_app_tests', 'string', ['string', 'string'], [
      String(msg.appJson || '{}'),
      String(msg.testFile || ''),
    ])
    post({ type: 'appTestsResult', requestId, ok: true, report: JSON.parse(text) })
  } catch (e) {
    post({ type: 'appTestsResult', requestId, ok: false, error: String(e && e.message ? e.message : e) })
  }
}
