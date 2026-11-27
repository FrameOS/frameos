#!/usr/bin/env node
// Pictures of layouts as a board would show them: the wasm runtime run as
// that board (its size, its canvas, its panel's pixel format, its event map),
// the repo's samples loaded beside the layout, and each picture dithered to
// the panel's inks the way the device's packer does (frameos/wasm/src/dither.ts).
// For pull requests and docs; nothing checks the pictures.
//
//   frameos/tools/build_wasm.sh --out DIR
//   node --experimental-strip-types frameos/tools/wasm_layout_shots.mjs DIR spec.json OUTDIR
//
// spec.json: { "shots": [{
//   "round": true,                    // a round panel (the board's own, or any board made round)
//   "name": "sticky-clock",           // OUTDIR/<name>.png
//   "board": "seeed_reterminal_sticky" (see BOARDS) | { width, height, pixelFormat, canvasBits, palette },
//   "rotate": 0,                      // the frame's rotation; the picture is the panel turned that way
//   "samples": ["Clock", "Weather demo", "Sticky layout"],  // folders of repo/scenes/samples
//   "layout": "layout-sticky",        // worn by every scene (frameos_wasm_choose_layout)
//   "layoutState": { ... },           // the layout's public fields
//   "scene": "clock",                 // shown first
//   "eventMap": [...] | "board",      // the frame's event map; "board" takes the board's own
//   "steps": [["event", "sceneSwitcher", {}], ["tap", x, y], ["wait", ms], ["render"]],
//   "framePage": true                 // offer the frame page (the gear)
// }] }
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const [wasmDirArg, specArg, outArg] = process.argv.slice(2)
if (!wasmDirArg || !specArg || !outArg) {
  console.error('usage: wasm_layout_shots.mjs WASM_DIR SPEC.json OUT_DIR')
  process.exit(2)
}
const wasmDir = resolve(wasmDirArg)
const outDir = resolve(outArg)
const { ditherFrame, panelPaletteFor } = await import(pathToFileURL(join(root, 'frameos', 'wasm', 'src', 'dither.ts')).href)

// A touch position on the wire: 0..WIRE_MAX across the panel (fos_touch.c).
const WIRE_MAX = 32767

// The reTerminal family and its event maps, as the planes seed them
// (backend/app/tasks/embedded_firmware.py, embedded/esp32/main/fos_board.c).
const ARROWS = [
  { event: 'button', match: { label: 'LEFT', action: 'longPress' }, emit: 'setCurrentScene', as: { direction: 'prev' } },
  { event: 'button', match: { label: 'RIGHT', action: 'longPress' }, emit: 'setCurrentScene', as: { direction: 'next' } },
]
const VOICE = [{ event: 'button', match: { label: 'REFRESH', action: 'longPress' }, emit: 'voiceChat', as: {} }]
const SWIPES = [
  { event: 'edgeSwipe', match: { edge: 'left' }, emit: 'back', as: {} },
  { event: 'edgeSwipe', match: { edge: 'right' }, emit: 'forward', as: {} },
  { event: 'edgeSwipe', match: { edge: 'bottom' }, emit: 'sceneSwitcher', as: {} },
  { event: 'edgeSwipe', match: { edge: 'top' }, emit: 'sceneSettings', as: {} },
]
const STICKY_KEYS = [
  { event: 'button', match: { label: 'UP', action: 'longPress' }, emit: 'setCurrentScene', as: { direction: 'prev' } },
  { event: 'button', match: { label: 'DOWN', action: 'longPress' }, emit: 'setCurrentScene', as: { direction: 'next' } },
  { event: 'button', match: { label: 'AI', action: 'doublePress' }, emit: 'back', as: {} },
  { event: 'button', match: { label: 'AI', action: 'triplePress' }, emit: 'sceneSwitcher', as: {} },
  { event: 'button', match: { label: 'AI', action: 'longPress' }, emit: 'voiceChat', as: {} },
]
const BOARDS = {
  seeed_reterminal_sticky: { width: 800, height: 480, pixelFormat: 4, canvasBits: 8, palette: 'fourGray', eventMap: [...STICKY_KEYS, ...SWIPES], buttons: ['AI', 'UP', 'DOWN'] },
  seeed_reterminal_e1001: { width: 800, height: 480, pixelFormat: 1, canvasBits: 8, palette: 'blackWhite', eventMap: [...ARROWS, ...VOICE], buttons: ['REFRESH', 'LEFT', 'RIGHT'] },
  seeed_reterminal_e1002: { width: 800, height: 480, pixelFormat: 7, canvasBits: 32, palette: 'spectra6', eventMap: [...ARROWS, ...VOICE], buttons: ['REFRESH', 'LEFT', 'RIGHT'] },
  seeed_reterminal_e1003: { panel: 'EPD_10in3', width: 1872, height: 1404, pixelFormat: 8, canvasBits: 4, palette: 'sixteenGray', eventMap: [...ARROWS, ...VOICE, ...SWIPES], buttons: ['REFRESH', 'LEFT', 'RIGHT'] },
  // Round: only the circle inside the square shows (panel_shape.nim
  // boardPanelRound). Its picture greys out the corners the glass hides.
  waveshare_esp32_s3_touch_amoled_1_75: { width: 466, height: 466, pixelFormat: 9, canvasBits: 16, round: true, eventMap: SWIPES, buttons: ['BOOT'] },
  seeed_reterminal_e1004: { panel: 'EPD_13in3e', width: 1200, height: 1600, pixelFormat: 7, canvasBits: 16, palette: 'spectra6', eventMap: [...ARROWS], buttons: ['RIGHT', 'LEFT', 'REFRESH'] },
}

const spec = JSON.parse(await readFile(resolve(specArg), 'utf8'))
const wasmBinary = await readFile(join(wasmDir, 'frameos.wasm'))
const { default: createFrameOS } = await import(pathToFileURL(join(wasmDir, 'frameos.js')).href)
await mkdir(outDir, { recursive: true })

async function samplesScenes(names) {
  const scenes = []
  for (const name of names) {
    const file = join(root, 'repo', 'scenes', 'samples', name, 'scenes.json')
    scenes.push(...JSON.parse(await readFile(file, 'utf8')))
  }
  return scenes
}

// A PNG of RGBA pixels: no dependency for one file format.
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function png(rgba, width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function shoot(shot) {
  const board = typeof shot.board === 'string' ? BOARDS[shot.board] : shot.board
  if (!board) throw new Error(`${shot.name}: unknown board ${shot.board}`)
  const rotate = shot.rotate ?? 0
  const round = shot.round ?? board.round ?? false
  const problems = []
  const Module = await createFrameOS({
    wasmBinary,
    print: () => {},
    printErr: (line) => problems.push(line),
    onFrameosLog: (line) => {
      if (/error/i.test(line)) problems.push(line)
    },
  })
  const call = (name, ret, types, args) => Module.ccall(name, ret, types, args)
  const lastError = () => call('frameos_wasm_last_error', 'string', [], [])
  // The runtime draws on the frame's canvas: the panel turned by the rotation.
  const turned = rotate === 90 || rotate === 270 || shot.portrait === true
  const width = turned ? board.height : board.width
  const height = turned ? board.width : board.height
  if (!call('frameos_wasm_init', 'boolean', ['number', 'number', 'string', 'string', 'string'],
    [width, height, shot.name, shot.timeZone ?? 'UTC', '{}'])) {
    throw new Error(`${shot.name}: init: ${lastError()}`)
  }
  call('frameos_wasm_set_embedded', null, ['boolean'], [true])
  call('frameos_wasm_set_canvas_bits_per_pixel', null, ['number'], [board.canvasBits])
  const eventMap = shot.eventMap === undefined || shot.eventMap === 'board' ? board.eventMap : shot.eventMap
  const gpioButtons = (board.buttons ?? []).map((label, i) => ({ pin: 3 + i, label }))
  if (!call('frameos_wasm_set_frame', 'boolean', ['string'], [JSON.stringify({ pixelFormat: board.pixelFormat, eventMap, gpioButtons, rotate, round, ...(board.panel ? { panel: board.panel } : {}) })])) {
    throw new Error(`${shot.name}: set_frame: ${lastError()}`)
  }
  if (shot.renderScale) call('frameos_wasm_set_render_scale', null, ['number'], [shot.renderScale])
  if (shot.framePage) call('frameos_wasm_set_frame_page', null, ['boolean'], [true])
  call('frameos_wasm_set_windowed', null, ['boolean'], [shot.windowed ?? true])
  const scenes = await samplesScenes(shot.samples)
  if (shot.layoutState && shot.layout) {
    for (const scene of scenes) {
      if (scene.id === shot.layout) {
        for (const field of scene.fields ?? []) {
          if (field.name in shot.layoutState) field.value = String(shot.layoutState[field.name])
        }
      }
    }
  }
  // What only a board knows (its battery, its signal), made up for a picture:
  // every app.frame read in a layout's sources goes through a proxy.
  if (shot.frameFacts) {
    for (const scene of scenes) {
      if (!scene.settings?.isLayout) continue
      for (const app of Object.values(scene.apps ?? {})) {
        for (const [file, text] of Object.entries(app.sources ?? {})) {
          if (!/\.(tsx|jsx|ts|js)$/.test(file)) continue
          app.sources[file] = `const __facts = ${JSON.stringify(shot.frameFacts)}\n` +
            `const __frame = (f) => new Proxy(f, { get: (t, k) => (k in __facts ? __facts[k] : t[k]) })\n` +
            text.replace(/app\.frame\b/g, '__frame(app.frame)')
        }
      }
    }
  }
  if (call('frameos_wasm_load_scenes', 'number', ['string'], [JSON.stringify(scenes)]) < 1) {
    throw new Error(`${shot.name}: load scenes: ${lastError()}`)
  }
  if (shot.layout) call('frameos_wasm_choose_layout', 'boolean', ['string'], [shot.layout])
  // A scene by its id or its name.
  const first = scenes.find((s) => s.id === shot.scene || s.name === shot.scene) ?? scenes.find((s) => !s.settings?.isLayout)
  if (!call('frameos_wasm_select_scene', 'boolean', ['string'], [first.id])) {
    throw new Error(`${shot.name}: select ${shot.scene}: ${lastError()}`)
  }
  const render = () => {
    const rc = call('frameos_wasm_render', 'number', [], [])
    if (rc !== 0) problems.push(`render returned ${rc}: ${lastError()}`)
  }
  render()
  for (const step of shot.steps ?? []) {
    const [kind, ...args] = step
    if (kind === 'event') {
      call('frameos_wasm_event', 'boolean', ['string', 'string'], [args[0], JSON.stringify(args[1] ?? {})])
    } else if (kind === 'tap') {
      // An ESP32's glass reports the touch in wire units over the panel
      // (fos_touch.c), which the runtime turns into the canvas's point.
      const at = {
        // On the canvas of an unturned frame ("portrait" included); a turned
        // one's glass is the panel, which this does not turn back.
        x: Math.round((args[0] * WIRE_MAX) / (width - 1)),
        y: Math.round((args[1] * WIRE_MAX) / (height - 1)),
        pointerId: 1, pointerType: 'touch', button: 0,
      }
      // The position first, then the press, as the page's pointer sends them.
      call('frameos_wasm_event', 'boolean', ['string', 'string'], ['pointerMove', JSON.stringify({ ...at, buttons: 0 })])
      call('frameos_wasm_event', 'boolean', ['string', 'string'], ['pointerDown', JSON.stringify({ ...at, buttons: 1 })])
      call('frameos_wasm_event', 'boolean', ['string', 'string'], ['pointerUp', JSON.stringify({ ...at, buttons: 0 })])
    } else if (kind === 'wait') {
      // Time passing, ticked as the page's worker does while input is timed.
      const until = Date.now() + (args[0] ?? 600)
      while (Date.now() < until) {
        call('frameos_wasm_tick', 'boolean', [], [])
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    } else if (kind === 'state') {
      // The state of the scene showing (its public fields).
      call('frameos_wasm_set_scene_state', 'boolean', ['string', 'string'], [first.id, JSON.stringify(args[0])])
    } else if (kind === 'input') {
      call('frameos_wasm_device_input', 'number', ['string'], [JSON.stringify(args[0])])
    }
    render()
  }
  const w = call('frameos_wasm_width', 'number', [], [])
  const h = call('frameos_wasm_height', 'number', [], [])
  const ptr = call('frameos_wasm_buffer', 'number', [], [])
  const rgba = new Uint8ClampedArray(Module.HEAPU8.buffer.slice(ptr, ptr + w * h * 4))
  const panel = panelPaletteFor(board.palette)
  if (panel && shot.dither !== false) ditherFrame(rgba, w, h, panel)
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
  if (round) {
    // What the glass hides, greyed: panel_shape.insideRound's circle.
    const d = Math.min(w, h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = 2 * x + 1 - w
        const dy = 2 * y + 1 - h
        if (dx * dx + dy * dy > d * d) {
          const i = (y * w + x) * 4
          rgba[i] = (rgba[i] >> 2) + 48
          rgba[i + 1] = (rgba[i + 1] >> 2) + 48
          rgba[i + 2] = (rgba[i + 2] >> 2) + 48
        }
      }
    }
  }
  await writeFile(join(outDir, `${shot.name}.png`), png(rgba, w, h))
  const shown = problems.filter((line) => !/^\s*$/.test(line))
  console.log(`${shot.name}: ${w}x${h}${shown.length ? `\n  ${shown.slice(0, 6).join('\n  ')}` : ''}`)
}

for (const shot of spec.shots) {
  if (process.env.ONLY && !shot.name.includes(process.env.ONLY)) continue
  await shoot(shot)
}
