// Writes panels.json: the virtual panels the UX bench runs, from the backend's
// hardware presets (dumped by dump_presets.py to presets.json) and the
// preview's ESP32 memory model (frameos/wasm/src/devices.ts).
// node --experimental-strip-types tools/ux-bench/gen_panels.mjs <presets.json>
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { esp32PreviewMemoryBytes, esp32CanvasBytesPerPixel } from '../../frameos/wasm/src/devices.ts'

const here = dirname(fileURLToPath(import.meta.url))
const presets = JSON.parse(readFileSync(process.argv[2], 'utf-8'))
const ROUND = new Set(['AMOLED_CO5300_466x466', 'LCD_ST77961_360x360'])
// The bench's boards, and the rotations worth a look.
const PANELS = {
  sensecap: ['seeed_sensecap_indicator_d1'],
  amoled175: ['waveshare_esp32_s3_touch_amoled_1_75'],
  crowwatch: ['elecrow_crowpanel_watch_2in01'],
  crowadv7: ['elecrow_crowpanel_advance_7'],
  crowadv28: ['elecrow_crowpanel_advance_2in8'],
  crowrot146: ['elecrow_crowpanel_rotary_1in46'],
  crow579: ['elecrow_crowpanel_5in79'],
  crowepd42: ['elecrow_crowpanel_epd_4in2'],
  sticky: ['seeed_reterminal_sticky'],
  'sticky-landscape': ['seeed_reterminal_sticky', 0],
  e1002: ['seeed_reterminal_e1002'],
  'e1002-portrait': ['seeed_reterminal_e1002', 90],
  e1003: ['seeed_reterminal_e1003'],
  'e1003-portrait': ['seeed_reterminal_e1003', 90],
  e1004: ['seeed_reterminal_e1004'],
  'e1004-landscape': ['seeed_reterminal_e1004', 90],
  pico: ['pimoroni_inky_frame_7_3_spectra'],
}
// Keys the firmware makes presses of only (a crown's or knob's turns).
const PRESS_ONLY = { elecrow_crowpanel_rotary_1in46: ['NEXT', 'PREV'], elecrow_crowpanel_watch_2in01: ['NEXT', 'PREV'] }
const out = {}
for (const [name, [presetKey, rotateOverride]] of Object.entries(PANELS)) {
  const p = presets[presetKey]
  const rotate = rotateOverride ?? p.rotate ?? 0
  const pins = Object.fromEntries((p.gpioButtons || []).map((b) => [b.label, b.pin]))
  let synthetic = 200
  const keys = (p.keys || []).map((k) => ({
    label: k.label, role: k.role, pin: pins[k.label] ?? synthetic++,
    ...(k.hold === false || PRESS_ONLY[presetKey]?.includes(k.label) ? { hold: false } : {}),
  }))
  const thin = p.platform !== 'esp32-s3'
  const psram = (p.psramMB || 8) * 1024 * 1024
  out[name] = {
    preset: presetKey, panel: p.panel, width: p.width, height: p.height, rotate,
    pixelFormat: p.pixelFormat, touch: p.touch, round: ROUND.has(p.panel), mic: p.mic,
    canvasBits: thin ? 32 : esp32CanvasBytesPerPixel(p.width, p.height, psram, p.pixelFormat) * 8,
    memoryBytes: thin ? 256 * 1024 * 1024 : esp32PreviewMemoryBytes(p.width, p.height, psram, p.pixelFormat, rotate),
    embedded: true,
    keys, gpioButtons: keys.map((k) => ({ pin: k.pin, label: k.label, role: k.role })),
    eventMap: p.eventMap || [],
  }
}
// The two Pi frames (HyperPixel 4.0 Square and 4.0): a Pi's runtime, the
// HyperPixel's own map (device_event_map_gen.nim).
const nimMaps = readFileSync(join(here, '../../frameos/src/frameos/device_event_map_gen.nim'), 'utf-8')
const hyper = JSON.parse(JSON.parse(nimMaps.match(/HyperPixelEventMap\* = (".*")/)[1]))
for (const [name, w, h, rotate] of [['pi-hyperpixel-sq', 720, 720, 0], ['pi-hyperpixel', 480, 800, 90]]) {
  out[name] = {
    preset: 'linux', panel: name, width: w, height: h, rotate, pixelFormat: 9, touch: true, round: false,
    canvasBits: 32, memoryBytes: 0, embedded: false, keys: [], gpioButtons: [], eventMap: hyper,
  }
}
writeFileSync(join(here, 'panels.json'), JSON.stringify(out, null, 1) + '\n')
for (const [k, v] of Object.entries(out)) console.log(k, v.width + 'x' + v.height, 'r' + v.rotate, 'fmt' + v.pixelFormat, 'bits' + v.canvasBits, 'mem' + (v.memoryBytes / 1048576).toFixed(1), v.keys.map((x) => x.label + ':' + x.role).join(' '))
