#!/usr/bin/env node
// UX bench: every repo sample scene on every virtual panel, in the wasm
// runtime, run as the board's own runtime would (its size, rotation, panel
// format, round glass, keys, event map, touch). For each scene:
//   render cold + warm, screenshot; keys pressed and held; edge swipes; taps on
//   every pressable region the press map names; a scroll drag. Every step is
//   timed and screenshotted, and what came up (scene switches, built-in scenes,
//   errors in the log) is recorded.
//
//   node tools/ux-bench/ux.mjs --wasm <dir> --panel <key> --out <dir> [--scenes regex] [--steps render,keys,swipes,taps,scroll]
//
// One process per panel: a wasm abort takes the module with it, and the
// harness starts a new one and goes on with the next scene.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = process.env.UX_REPO || resolve(here, '../..') // UX_REPO: another checkout's samples

// ------------------------------------------------------------------ args
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true'
    args[k] = v
  }
}
const WASM = args.wasm
const OUT = args.out
const PANEL_KEY = args.panel
const STEPS = new Set((args.steps || 'render,keys,swipes,taps,scroll').split(','))
const SCENE_RE = args.scenes ? new RegExp(args.scenes, 'i') : null
const MAX_TAPS = Number(args.taps || 6)
const LAYOUT = args.layout || '' // a layout sample's folder: every scene wears it
const BUILTINS = !!args.builtins // the scene list, settings and frame page instead of the scenes
const CACHE_DIR = args.cache || join(process.env.HOME, '.frameos-bench/ux/http-cache')
mkdirSync(CACHE_DIR, { recursive: true })

const panels = JSON.parse(readFileSync(join(here, 'panels.json'), 'utf-8'))
const panel = panels[PANEL_KEY]
if (!panel) throw new Error(`no panel ${PANEL_KEY}`)

// ------------------------------------------------------------- scenes
function loadSamples() {
  const root = join(repoRoot, 'repo/scenes/samples')
  const all = []
  for (const dir of readdirSync(root).sort()) {
    const file = join(root, dir, 'scenes.json')
    if (!existsSync(file)) continue
    let scenes
    try {
      scenes = JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      continue
    }
    for (const s of scenes) all.push({ ...s, __folder: dir })
  }
  return all
}
const allScenes = loadSamples()
const ids = new Set()
const scenes = allScenes.filter((s) => {
  if (ids.has(s.id)) return false
  ids.add(s.id)
  return true
})
const sceneList = scenes.filter((s) => !s.settings?.isLayout)
const tested = sceneList.filter((s) => !SCENE_RE || SCENE_RE.test(s.__folder) || SCENE_RE.test(s.name || ''))

// ------------------------------------------------------------- network
const rendererSource = readFileSync(join(repoRoot, 'backend/tools/embedded_wasm_render.mjs'), 'utf-8')
const FETCH_CHILD_SCRIPT = rendererSource.split('const FETCH_CHILD_SCRIPT = `')[1].split('\n`\n')[0]
  .replace(/\\\\/g, '\\')
let fetchCount = 0
let fetchMs = 0
class SyncXMLHttpRequest {
  open(method, url) {
    this._method = method
    this._url = url
    this._headers = {}
    this.status = 0
    this.response = null
    this.responseText = ''
  }
  setRequestHeader(n, v) {
    this._headers[n] = v
  }
  getAllResponseHeaders() {
    return this._responseHeaders || ''
  }
  send(body) {
    const key = createHash('sha1').update(`${this._method} ${this._url} ${body ? Buffer.from(body).toString('base64') : ''}`).digest('hex')
    const cacheFile = join(CACHE_DIR, key + '.json')
    let result
    const started = Date.now()
    if (existsSync(cacheFile)) {
      result = JSON.parse(readFileSync(cacheFile, 'utf-8'))
    } else {
      const request = {
        method: this._method, url: this._url, headers: this._headers, timeoutMs: this.timeout || 15000,
        bodyBase64: body ? Buffer.from(body).toString('base64') : '', networkPolicy: 'public',
        maxBodyBytes: 23 * 1024 * 1024,
      }
      const child = spawnSync(process.execPath, ['-e', FETCH_CHILD_SCRIPT], {
        input: JSON.stringify(request), maxBuffer: 32 * 1024 * 1024, timeout: (this.timeout || 15000) + 5000,
      })
      if (child.status !== 0 || !child.stdout?.length) {
        result = { status: 0, error: `fetch child failed: ${child.stderr || child.status}` }
      } else {
        result = JSON.parse(child.stdout.toString('utf-8'))
      }
      if (result.status && result.status < 500) {
        const tmp = `${cacheFile}.${process.pid}`
        writeFileSync(tmp, JSON.stringify(result))
        renameSync(tmp, cacheFile)
      }
    }
    fetchCount++
    fetchMs += Date.now() - started
    if (result.status === 0) throw new Error(result.error || 'request failed')
    this.status = result.status
    this._responseHeaders = result.headers || ''
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

// ------------------------------------------------------------------ png
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function writePng(file, rgba, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      const d = y * (w * 3 + 1) + 1 + x * 3
      raw[d] = rgba[s]
      raw[d + 1] = rgba[s + 1]
      raw[d + 2] = rgba[s + 2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 1 })), pngChunk('IEND', Buffer.alloc(0)),
  ]))
}

// ------------------------------------------------------------- module
const wasmBinary = readFileSync(join(WASM, 'frameos.wasm'))
const { default: createFrameOS } = await import(pathToFileURL(join(WASM, 'frameos.js')).href)
let Module = null
let logs = []
let events = []
async function newModule() {
  Module = await createFrameOS({
    wasmBinary,
    arguments: [],
    thisProgram: 'frameos',
    print: (l) => { logs.push(String(l)); if (process.env.UXDEBUG) console.error('P', l) },
    printErr: (l) => { logs.push(String(l)); if (process.env.UXDEBUG) console.error('E', l) },
    onFrameosLog: (l) => logs.push(String(l)),
    onFrameosEvent: (name, payload) => events.push({ name, payload }),
  })
}
const call = (name, ret, types, a) => Module.ccall(name, ret, types, a)
const lastError = () => {
  try {
    return call('frameos_wasm_last_error', 'string', [], [])
  } catch (e) {
    return String(e)
  }
}

// The scene's canvas (what the board's runtime draws: turned by its rotation).
const turned = panel.rotate === 90 || panel.rotate === 270
const W = turned ? panel.height : panel.width
const H = turned ? panel.width : panel.height

// What a frame has installed besides the scene under test: a dozen common
// scenes, so the scene list, next/previous and Home have something to show.
const COMPANIONS = ['Clock', 'Calculator', 'Weather', 'XKCD', 'Snake', 'Counter', 'To-do', 'Word clock', 'Sudoku',
  'Gallery', 'Countdown', 'Sun and moon']
const layoutScene = LAYOUT ? scenes.find((s) => s.__folder === LAYOUT && s.settings?.isLayout) : null
if (LAYOUT && !layoutScene) throw new Error(`no layout ${LAYOUT}`)
function frameScenes(under) {
  const list = [under]
  if (layoutScene) list.push(layoutScene)
  for (const name of COMPANIONS) {
    const s = sceneList.find((x) => x.__folder === name)
    if (s && s.id !== under.id) list.push(s)
  }
  return list
}

async function boot(under) {
  await newModule()
  if (!call('frameos_wasm_init', 'boolean', ['number', 'number', 'string', 'string', 'string'],
    [W, H, `ux ${PANEL_KEY}`, 'Europe/Brussels', '{}'])) throw new Error('init: ' + lastError())
  if (panel.embedded !== false) call('frameos_wasm_set_embedded', null, ['boolean'], [true])
  if (panel.canvasBits) call('frameos_wasm_set_canvas_bits_per_pixel', null, ['number'], [panel.canvasBits])
  call('frameos_wasm_set_frame_page', null, ['boolean'], [true])
  const frame = {
    eventMap: panel.eventMap && panel.eventMap.length ? panel.eventMap : null,
    pixelFormat: panel.pixelFormat,
    gpioButtons: panel.gpioButtons || [],
    rotate: panel.rotate || 0,
    round: !!panel.round,
    panel: panel.panel,
  }
  if (!call('frameos_wasm_set_frame', 'boolean', ['string'], [JSON.stringify(frame)])) {
    throw new Error('set_frame: ' + lastError())
  }
  const payload = JSON.stringify(frameScenes(under).map(({ __folder, ...s }) => s))
  const loaded = call('frameos_wasm_load_scenes', 'number', ['string'], [payload])
  if (!loaded) throw new Error('load: ' + lastError())
  if (layoutScene) {
    if (!call('frameos_wasm_choose_layout', 'boolean', ['string'], [layoutScene.id])) throw new Error('layout: ' + lastError())
  }
  // The device's ceiling, from here on: its scenes live in flash, not in
  // what it renders with (the limit's baseline is what is live now).
  if (panel.memoryBytes) {
    call('frameos_wasm_set_memory_limit', null, ['number', 'number'], [panel.memoryBytes, 0])
  }
  return loaded
}

function info() {
  return JSON.parse(call('frameos_wasm_scene_info', 'string', [], []))
}
function currentScene() {
  return info().currentSceneId
}

let lastPixels = null
function render() {
  const t0 = performance.now()
  let code
  try {
    code = call('frameos_wasm_render', 'number', [], [])
  } catch (e) {
    return { code: -1, ms: performance.now() - t0, error: String(e), aborted: true }
  }
  const ms = performance.now() - t0
  const ptr = call('frameos_wasm_buffer', 'number', [], [])
  const len = call('frameos_wasm_buffer_len', 'number', [], [])
  const w = call('frameos_wasm_width', 'number', [], [])
  const h = call('frameos_wasm_height', 'number', [], [])
  const pixels = ptr && len ? Buffer.from(new Uint8Array(Module.HEAPU8.buffer, ptr, len)) : null
  return { code, ms, w, h, pixels, error: code !== 0 ? lastError() : '' }
}

// ------------------------------------------------------------ analysis
function analyze(px, w, h) {
  if (!px) return { blank: true }
  // Background: the most common colour of the border.
  const counts = new Map()
  const at = (x, y) => {
    const i = (y * w + x) * 4
    return (px[i] << 16) | (px[i + 1] << 8) | px[i + 2]
  }
  for (let x = 0; x < w; x += 2) {
    for (const y of [0, h - 1]) counts.set(at(x, y), (counts.get(at(x, y)) || 0) + 1)
  }
  for (let y = 0; y < h; y += 2) {
    for (const x of [0, w - 1]) counts.set(at(x, y), (counts.get(at(x, y)) || 0) + 1)
  }
  let bg = 0
  let best = -1
  for (const [c, n] of counts) if (n > best) [bg, best] = [c, n]
  let distinct = new Set()
  let nonBg = 0
  let outsideCircle = 0
  let outsideCircleTotal = 0
  const cx = w / 2
  const cy = h / 2
  const r = Math.min(w, h) / 2
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = at(x, y)
      if (distinct.size < 4096) distinct.add(c)
      const isContent = c !== bg
      if (isContent) {
        nonBg++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      if (panel.round) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        if (d > r - 1) {
          outsideCircleTotal++
          if (isContent) outsideCircle++
        }
      }
    }
  }
  const total = w * h
  // Content touching an edge: rows/columns of the outer 2 px where many pixels are not background.
  const edgeContent = {}
  for (const [name, xs, ys] of [
    ['left', [0, 1], null], ['right', [w - 1, w - 2], null], ['top', null, [0, 1]], ['bottom', null, [h - 1, h - 2]],
  ]) {
    let hit = 0
    let all = 0
    if (xs) for (const x of xs) for (let y = 0; y < h; y++) { all++; if (at(x, y) !== bg) hit++ }
    if (ys) for (const y of ys) for (let x = 0; x < w; x++) { all++; if (at(x, y) !== bg) hit++ }
    edgeContent[name] = Math.round((hit / all) * 1000) / 1000
  }
  return {
    bg: '#' + bg.toString(16).padStart(6, '0'),
    colors: distinct.size,
    content: Math.round((nonBg / total) * 1000) / 1000,
    blank: distinct.size <= 1,
    bbox: maxX >= 0 ? [minX, minY, maxX, maxY] : null,
    edgeContent,
    ...(panel.round ? { outsideCircle: outsideCircleTotal ? Math.round((outsideCircle / outsideCircleTotal) * 1000) / 1000 : 0 } : {}),
  }
}
function diffFraction(a, b) {
  if (!a || !b || a.length !== b.length) return 1
  let d = 0
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) d++
  }
  return Math.round((d / (a.length / 4)) * 10000) / 10000
}

// --------------------------------------------------------------- input
const WIRE = 32767
// The glass reports where it was touched on the PANEL (unturned); a scene
// point (x, y) on a frame turned by `rotate` is this panel point.
function sceneToPanel(x, y) {
  const r = panel.rotate || 0
  // input_state turns a panel point into a scene point; this is its inverse.
  // panelToScenePoint (utils/image.nim): 90: (py, W-1-px); 270: (H-1-py, px).
  if (r === 90) return [panel.width - 1 - y, x]
  if (r === 180) return [panel.width - 1 - x, panel.height - 1 - y]
  if (r === 270) return [y, panel.height - 1 - x]
  return [x, y]
}
function wire(x, y) {
  const [px, py] = sceneToPanel(x, y)
  return [Math.round((px / Math.max(1, panel.width - 1)) * WIRE), Math.round((py / Math.max(1, panel.height - 1)) * WIRE)]
}
let clock = 1_000_000
function deviceInput(evs, edges) {
  const nowMs = clock
  try {
    return call('frameos_wasm_device_input', 'number', ['string'], [JSON.stringify({ nowMs, ...(edges ? { edges } : {}), ...(evs ? { events: evs } : {}) })])
  } catch (e) {
    return -2
  }
}
function pointer(name, x, y, atMs, id = 0) {
  const [wx, wy] = wire(x, y)
  const down = name !== 'pointerUp'
  return { origin: 'driver', name, payload: { x: wx, y: wy, pointerId: id, pointerType: 'touch', button: 0, buttons: down ? 1 : 0, atMs } }
}
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
// A gesture whose events are all in the past (relayed input times them by
// atMs), then time passing for the dispatcher's tick.
function tap(x, y) {
  clock += 1000
  return deviceInput([pointer('pointerDown', x, y, clock - 120), pointer('pointerUp', x, y, clock - 40)])
}
function drag(points, durationMs) {
  clock += durationMs + 1000
  const start = clock - durationMs - 50
  const evs = [pointer('pointerDown', points[0][0], points[0][1], start)]
  for (let i = 1; i < points.length; i++) {
    evs.push(pointer('pointerMove', points[i][0], points[i][1], start + Math.round((durationMs * i) / (points.length - 1))))
  }
  const last = points[points.length - 1]
  evs.push(pointer('pointerUp', last[0], last[1], clock - 40))
  return deviceInput(evs)
}
function key(label, pin, holdMs) {
  clock += holdMs + 1000
  const down = clock - holdMs - 60
  const r1 = deviceInput(null, [{ label, pin, action: 'down', atMs: down }])
  // Let time pass while it is held (the dispatcher's tick makes a long press at the threshold).
  try {
    call('frameos_wasm_tick', 'boolean', [], [])
  } catch {}
  const r2 = deviceInput(null, [{ label, pin, action: 'up', atMs: clock - 60 }])
  return [r1, r2]
}
function pressMap() {
  try {
    const s = call('frameos_wasm_press_map', 'string', [], [])
    if (!s) return []
    return s.split(';').map((e) => {
      const taken = !e.startsWith('!')
      const [x0, y0, x1, y1] = e.replace('!', '').split(',').map(Number)
      return { taken, x0, y0, x1, y1 }
    })
  } catch {
    return []
  }
}
function keptScrolls(sceneId) {
  try {
    const kept = JSON.parse(call('frameos_wasm_kept_state', 'string', [], []))
    return (kept.targets || []).filter((t) => t.scrolls && (!sceneId || t.sceneId === sceneId)).map((t) => t.scrolls)
  } catch {
    return []
  }
}

// --------------------------------------------------------------- run
const outDir = join(OUT, PANEL_KEY + (LAYOUT ? '@' + LAYOUT.replace(/[^a-zA-Z0-9]+/g, '-') : '') + (BUILTINS ? '@builtins' : ''))
mkdirSync(outDir, { recursive: true })
const results = []
const safe = (s) => s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60)
const ERROR_RE = /error|exception|failed|not a function|undefined is not|cannot read|out of memory|abort/i
function takeLogs() {
  const l = logs
  logs = []
  return l
}
function takeEvents() {
  const e = events
  events = []
  return e
}
function errorsIn(lines) {
  return lines.filter((l) => ERROR_RE.test(l) && !/"event":"render:/.test(l)).slice(0, 12).map((l) => l.slice(0, 400))
}

console.error(`[${PANEL_KEY}] ${W}x${H} rot ${panel.rotate || 0} fmt ${panel.pixelFormat} round=${!!panel.round} touch=${!!panel.touch}: testing ${tested.length}`)


// ------------------------------------------------------------ built-ins
// The scene list with a frame's worth of scenes, walked by touch and by keys;
// the settings of a scene with many fields; the frame page.
async function runBuiltins() {
  const many = sceneList.filter((_, i) => i % 3 === 0).slice(0, 44)
  const home = sceneList.find((s) => s.__folder === 'Clock')
  const set = [home, ...many.filter((s) => s.id !== home.id)]
  const results = []
  const shots = []
  let prev = null
  const save = (tag, r) => {
    if (!r.pixels) return null
    const f = `builtin.${tag}.png`
    writePng(join(outDir, f), r.pixels, r.w, r.h)
    return f
  }
  const step = (tag, fn) => {
    const before = currentScene()
    const t0 = performance.now()
    const delivered = fn()
    const inputMs = performance.now() - t0
    const r = render()
    const l = takeLogs()
    const s = { tag, before, after: currentScene(), delivered, inputMs: Math.round(inputMs), renderMs: Math.round(r.ms), code: r.code,
      changed: diffFraction(prev, r.pixels), logErrors: errorsIn(l), error: r.error, shot: save(tag, r),
      press: pressMap().filter((p) => p.taken).length }
    prev = r.pixels
    results.push(s)
    console.error(`[${PANEL_KEY}] ${tag}: ${s.after} ${s.renderMs} ms changed ${s.changed}`)
    return s
  }
  const ev = (name, payload = {}) => () => call('frameos_wasm_event', 'boolean', ['string', 'string'], [name, JSON.stringify(payload)])
  // boot with the big set
  await newModule()
  call('frameos_wasm_init', 'boolean', ['number', 'number', 'string', 'string', 'string'], [W, H, `ux ${PANEL_KEY}`, 'Europe/Brussels', '{}'])
  if (panel.embedded !== false) call('frameos_wasm_set_embedded', null, ['boolean'], [true])
  if (panel.canvasBits) call('frameos_wasm_set_canvas_bits_per_pixel', null, ['number'], [panel.canvasBits])
  call('frameos_wasm_set_frame_page', null, ['boolean'], [true])
  call('frameos_wasm_set_frame', 'boolean', ['string'], [JSON.stringify({ eventMap: panel.eventMap?.length ? panel.eventMap : null,
    pixelFormat: panel.pixelFormat, gpioButtons: panel.gpioButtons || [], rotate: panel.rotate || 0, round: !!panel.round, panel: panel.panel })])
  const payload = [...set, ...(layoutScene ? [layoutScene] : [])].map(({ __folder, ...x }) => x)
  call('frameos_wasm_load_scenes', 'number', ['string'], [JSON.stringify(payload)])
  if (layoutScene) call('frameos_wasm_choose_layout', 'boolean', ['string'], [layoutScene.id])
  if (panel.memoryBytes) call('frameos_wasm_set_memory_limit', null, ['number', 'number'], [panel.memoryBytes, 0])
  call('frameos_wasm_select_scene', 'boolean', ['string'], [home.id])
  step('00-home-scene', () => 0)
  const keys = panel.keys || []
  const byRole = (role) => keys.find((k) => {
    const r = k.role
    if (role === 'next') return ['next', 'right', 'down'].includes(r)
    if (role === 'prev') return ['prev', 'left', 'up'].includes(r)
    return r === role
  })
  const walk = (prefix) => {
    if (panel.touch) {
      const x = Math.round(W / 2)
      for (let i = 1; i <= 3; i++) {
        step(`${prefix}-drag${i}`, () => drag([0.8, 0.65, 0.5, 0.35, 0.2].map((f) => [x, Math.round(H * f)]), 500))
      }
      // A flick back to the top.
      step(`${prefix}-drag-back`, () => drag([0.2, 0.5, 0.8].map((f) => [x, Math.round(H * f)]), 200))
    }
    const next = byRole('next')
    const prevKey = byRole('prev')
    const primary = byRole('primary') || byRole('refresh')
    if (next) {
      for (let i = 1; i <= 3; i++) step(`${prefix}-next${i}`, () => key(next.label, next.pin, 90))
      if (next.hold !== false) step(`${prefix}-next-hold`, () => key(next.label, next.pin, 1400))
    }
    if (prevKey) step(`${prefix}-prev`, () => key(prevKey.label, prevKey.pin, 90))
    return primary
  }
  // The scene list.
  step('10-switcher-open', ev('sceneSwitcher'))
  const primary = walk('11-switcher')
  if (primary && currentScene() === SWITCHER_ID) step('12-switcher-primary-press', () => key(primary.label, primary.pin, 90))
  call('frameos_wasm_select_scene', 'boolean', ['string'], [home.id])
  step('19-back-home', () => 0)
  // Settings of scenes with many fields.
  for (const folder of ['Clock', 'Weather', 'Form showcase', 'Kitchen sink', 'Browser']) {
    const sc = set.find((x) => x.__folder === folder) || sceneList.find((x) => x.__folder === folder)
    if (!set.includes(sc)) continue
    call('frameos_wasm_select_scene', 'boolean', ['string'], [sc.id])
    render()
    takeLogs()
    const tag = folder.replace(/[^a-zA-Z0-9]+/g, '-')
    step(`20-settings-${tag}`, ev('sceneSettings'))
    walk(`21-settings-${tag}`)
    step(`22-settings-${tag}-close`, ev('sceneSettings'))
  }
  // The frame page.
  call('frameos_wasm_select_scene', 'boolean', ['string'], [home.id])
  render()
  step('30-frame-page', ev('sceneSettings', { page: 'frame' }))
  walk('31-frame-page')
  writeFileSync(join(outDir, 'builtins.json'), JSON.stringify({ panel: PANEL_KEY, layout: LAYOUT, W, H, results }, null, 1))
}
const SWITCHER_ID = 'system/sceneSwitcher'
if (BUILTINS) {
  mkdirSync(outDir, { recursive: true })
  await runBuiltins()
  process.exit(0)
}

for (const scene of tested) {
  const rec = { scene: scene.id, folder: scene.__folder, name: scene.name, order: frameScenes(scene).filter((s) => !s.settings?.isLayout).map((s) => s.id), steps: [] }
  const base = safe(scene.__folder)
  const shot = (tag, r) => {
    if (!r.pixels) return null
    const f = `${base}.${tag}.png`
    writePng(join(outDir, f), r.pixels, r.w, r.h)
    return f
  }
  try {
    await boot(scene)
    takeLogs()
    takeEvents()
    fetchCount = 0
    fetchMs = 0
    if (!call('frameos_wasm_select_scene', 'boolean', ['string'], [scene.id])) {
      rec.error = 'select failed: ' + lastError()
      results.push(rec)
      continue
    }
    const cold = render()
    if (cold.aborted) throw new Error('abort in render: ' + cold.error)
    if (cold.code === 3) {
      let failed = 0
      try { failed = call('frameos_wasm_memory_failed', 'number', [], []) } catch {}
      throw new Error(`out of memory in the first render (refused ${failed} bytes)`)
    }
    const warm = render()
    const coldLogs = takeLogs()
    rec.render = {
      code: cold.code, coldMs: Math.round(cold.ms), warmMs: Math.round(warm.ms), fetches: fetchCount, fetchMs,
      error: cold.error || warm.error, size: [cold.w, cold.h],
      shot: shot('0-render', warm.pixels ? warm : cold),
      analysis: analyze((warm.pixels ? warm : cold).pixels, cold.w, cold.h),
      logErrors: errorsIn(coldLogs),
      nextSleep: call('frameos_wasm_next_sleep', 'number', [], []),
      interval: call('frameos_wasm_scene_interval', 'number', [], []),
    }
    try {
      rec.render.memPeak = call('frameos_wasm_memory_peak', 'number', [], [])
      rec.render.memFailed = call('frameos_wasm_memory_failed', 'number', [], [])
    } catch {}
    const press = pressMap()
    rec.pressMap = press
    // Pressable regions off the panel, or outside the round glass.
    const pw = panel.width
    const ph = panel.height
    rec.pressProblems = press.filter((p) => p.taken).flatMap((p) => {
      const out = []
      if (p.x0 < 0 || p.y0 < 0 || p.x1 > pw || p.y1 > ph) out.push({ kind: 'offPanel', ...p })
      if (p.x1 - p.x0 < 1 || p.y1 - p.y0 < 1) out.push({ kind: 'empty', ...p })
      if (panel.round) {
        const cx = (p.x0 + p.x1) / 2
        const cy = (p.y0 + p.y1) / 2
        if (Math.hypot(cx - pw / 2, cy - ph / 2) > Math.min(pw, ph) / 2 - 4) out.push({ kind: 'centreOutsideCircle', ...p })
      }
      return out
    })
    let prev = warm.pixels || cold.pixels
    takeEvents()

    const restore = () => {
      if (currentScene() !== scene.id) call('frameos_wasm_select_scene', 'boolean', ['string'], [scene.id])
      const r = render()
      prev = r.pixels
      takeLogs()
      takeEvents()
    }

    const step = (kind, label, fn) => {
      const before = currentScene()
      const t0 = performance.now()
      const delivered = fn()
      const inputMs = performance.now() - t0
      const ev = takeEvents()
      const wanted = Module && call('frameos_wasm_render_requested', 'boolean', [], [])
      const r = render()
      const after = currentScene()
      const l = takeLogs()
      const s = {
        kind, label, delivered, before, after, renderRequested: wanted,
        inputMs: Math.round(inputMs), renderMs: Math.round(r.ms), code: r.code,
        changed: diffFraction(prev, r.pixels), events: ev.map((e) => e.name).filter((n) => !/^render/.test(n)).slice(0, 10),
        logErrors: errorsIn(l), error: r.error,
      }
      if (r.aborted) s.aborted = true
      if (s.changed > 0 || after !== before) s.shot = shot(`${kind}-${safe(label)}`, r)
      prev = r.pixels
      rec.steps.push(s)
      if (r.aborted) throw new Error(`abort after ${kind} ${label}: ${r.error}`)
      return s
    }

    if (STEPS.has('keys')) {
      for (const k of panel.keys || []) {
        for (const [action, ms] of (k.hold === false ? [['press', 90]] : [['press', 90], ['hold', 1400]])) {
          step('key', `${k.label}-${action}`, () => key(k.label, k.pin ?? -1, ms))
          restore()
        }
      }
      // Two keys together (Back on a board without a Back key).
      const held = (panel.keys || []).filter((k) => k.hold !== false)
      if (held.length >= 2 && !(panel.keys || []).some((k) => k.role === 'back')) {
        const [a, b] = held
        step('key', `${a.label}+${b.label}-press`, () => {
          clock += 1200
          return deviceInput(null, [
            { label: a.label, pin: a.pin ?? -1, action: 'down', atMs: clock - 300 },
            { label: b.label, pin: b.pin ?? -1, action: 'down', atMs: clock - 280 },
            { label: a.label, pin: a.pin ?? -1, action: 'up', atMs: clock - 150 },
            { label: b.label, pin: b.pin ?? -1, action: 'up', atMs: clock - 140 },
          ])
        })
        restore()
      }
    }
    if (STEPS.has('swipes') && panel.touch) {
      const m = Math.round(Math.min(W, H) * 0.35)
      const swipes = {
        left: [[2, H / 2], [m, H / 2]], right: [[W - 3, H / 2], [W - 1 - m, H / 2]],
        top: [[W / 2, 2], [W / 2, m]], bottom: [[W / 2, H - 3], [W / 2, H - 1 - m]],
      }
      if (panel.round) {
        // From the rim: the circle's edge at each side.
        const r = Math.min(W, H) / 2
        swipes.left = [[W / 2 - r + 3, H / 2], [W / 2 - r + 3 + m, H / 2]]
        swipes.right = [[W / 2 + r - 4, H / 2], [W / 2 + r - 4 - m, H / 2]]
        swipes.top = [[W / 2, H / 2 - r + 3], [W / 2, H / 2 - r + 3 + m]]
        swipes.bottom = [[W / 2, H / 2 + r - 4], [W / 2, H / 2 + r - 4 - m]]
      }
      for (const [edge, [a, b]] of Object.entries(swipes)) {
        const pts = [0, 0.25, 0.5, 0.75, 1].map((t) => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t)])
        step('swipe', edge, () => drag(pts, 220))
        restore()
      }
    }
    if (STEPS.has('taps') && panel.touch) {
      const taken = press.filter((p) => p.taken && p.x1 > p.x0 && p.y1 > p.y0)
      // Spread the picks across the list.
      const picks = []
      for (let i = 0; i < Math.min(MAX_TAPS, taken.length); i++) picks.push(taken[Math.floor((i * taken.length) / Math.min(MAX_TAPS, taken.length))])
      for (const p of picks) {
        // Panel point -> scene point.
        const px = (p.x0 + p.x1) / 2
        const py = (p.y0 + p.y1) / 2
        const r = panel.rotate || 0
        let sx = px
        let sy = py
        if (r === 90) [sx, sy] = [py, panel.width - 1 - px]
        else if (r === 180) [sx, sy] = [panel.width - 1 - px, panel.height - 1 - py]
        else if (r === 270) [sx, sy] = [panel.height - 1 - py, px]
        const s = step('tap', `${Math.round(sx)},${Math.round(sy)}`, () => tap(Math.round(sx), Math.round(sy)))
        if (s.after !== scene.id) restore()
      }
    }
    if (STEPS.has('scroll') && panel.touch) {
      const x = Math.round(W / 2)
      const pts = [0.7, 0.6, 0.5, 0.4, 0.3].map((f) => [x, Math.round(H * f)])
      const s = step('scroll', 'up', () => drag(pts, 400))
      s.scrolls = keptScrolls(scene.id)
      if (s.after !== scene.id) restore()
    }
  } catch (e) {
    rec.error = String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)
    rec.logs = takeLogs().slice(-20)
  }
  results.push(rec)
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ ...panel, panelKey: PANEL_KEY, layout: LAYOUT, W, H, eventMap: undefined, results }, null, 1))
  const r = rec.render || {}
  console.error(`[${PANEL_KEY}] ${scene.__folder}: ${rec.error ? 'ERROR ' + rec.error.slice(0, 120) : `cold ${r.coldMs}ms warm ${r.warmMs}ms ${r.analysis?.blank ? 'BLANK ' : ''}${rec.steps.length} steps`}`)
}
console.error(`[${PANEL_KEY}] done`)
