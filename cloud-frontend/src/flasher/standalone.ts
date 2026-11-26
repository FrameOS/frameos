import { EMBEDDED_ESP32_S3 } from '../../../frontend/src/devices'
import { ESP32_HARDWARE_PRESET_CONFIGS } from '../../../frontend/src/scenes/frame/panels/FrameSettings/esp32Hardware'
import type { ProvisioningCommands } from '../../../frontend/src/scenes/workspace/embeddedFlashRun'
import type { EmbeddedUsbConfigKey } from '../../../frontend/src/models/embeddedUsbLogsModel'
import { SCENE_STORE_ID, type FlasherSample } from './sampleCatalog'

// A standalone ESP32 (cloud/docs/flasher.md "A standalone frame"): a board
// with no backend and no account, set up by flash.frameos.net from what the
// person picks. The boards are the SPA's hardware presets (one table, which
// mirrors the backend's and the firmware's: esp32Hardware.ts) for an
// ESP32-S3 — a C3 or a Pico is a thin client and needs a plane to render for
// it — plus any other S3 with a panel wired to it.

/** "Other ESP32-S3 board": a panel wired to it, the XIAO's pins unless told. */
export const CUSTOM_BOARD = 'custom'

// The touch boards: their on-screen frame page joins a network (a swipe down
// from the top, then the gear), so Wi-Fi may wait (docs/scene-settings.md
// "A boot that does not wait for the network"). A standalone frame runs its
// firmware's event map (fos_board.c k_event_maps), and these are the boards
// whose map has more than button rules (`edge_swipes`): the frames that take
// taps (`takesNoTaps` in system/sceneSwitcher/scene.nim says the rest take
// none). flasher-standalone.test.ts reads fos_board.c for it.
export const TOUCH_PRESETS = new Set([
  'seeed_reterminal_sticky',
  'seeed_reterminal_e1003',
  'seeed_sensecap_indicator_d1',
  'guition_esp32_4848s040',
  'sunton_esp32_8048s070',
  'waveshare_esp32_s3_touch_amoled_1_75',
])

export interface StandaloneBoard {
  key: string
  label: string
  /** A carrier board for many panels (the XIAO EE04/EE05): pick the panel. */
  panelSelectable: boolean
  /** Its own default panel, as a console key. */
  defaultPanel: string | null
  /** The rotation the board is held at (the Sticky stands portrait). */
  rotate: number | null
  touch: boolean
  /** A fast screen (an LCD or an AMOLED): it shows what redraws many times a second. */
  fast: boolean
  /** The flash the board comes with, which decides its layout and so its `/state`. */
  flashSize: string
}

/** A panel that redraws fast: an LCD or an AMOLED. Every other ESP32 panel is e-paper. */
function deviceIsFast(device: string): boolean {
  return device.startsWith('lcd.') || device.startsWith('amoled.')
}

/** The console's panel key for a device id ('waveshare.EPD_7in5_V2' → 'EPD_7in5_V2'). */
function consolePanelKey(device: string): string | null {
  const key = device.split('.').pop() ?? ''
  return /^[A-Za-z0-9_]+$/.test(key) ? key : null
}

export const standaloneBoards: StandaloneBoard[] = Object.entries(ESP32_HARDWARE_PRESET_CONFIGS)
  .filter(([, config]) => config?.platform === EMBEDDED_ESP32_S3)
  .map(([key, config]) => ({
    key,
    label: config!.label,
    panelSelectable: config!.panelSelectable === true,
    defaultPanel: consolePanelKey(config!.device),
    rotate: typeof config!.rotate === 'number' ? config!.rotate : null,
    touch: TOUCH_PRESETS.has(key),
    fast: deviceIsFast(config!.device),
    flashSize: config!.flashSize,
  }))
  .sort((a, b) => a.label.localeCompare(b.label))

export function standaloneBoard(key: string | null | undefined): StandaloneBoard | null {
  return standaloneBoards.find((board) => board.key === key) ?? null
}

/** The board a `?board=` link names: a preset key, or `custom`. */
export function boardFromQuery(search: string): string | null {
  const value = new URLSearchParams(search).get('board')
  if (!value) {
    return null
  }
  return value === CUSTOM_BOARD || standaloneBoard(value) ? value : null
}

/** A DHCP hostname from the frame's name, as the backend makes one from a
 * frame's host (embedded_hostname_for_frame): letters, digits, dashes, 31
 * at most. */
export function standaloneHostname(name: string): string {
  const hostname = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return hostname.slice(0, 31).replace(/-+$/, '') || 'frameos'
}

// A pin spec as `set pins` takes it: key=number pairs, commas between.
const PIN_SPEC = /^(?:[a-z0-9_]+=-?\d{1,3})(?:,[a-z0-9_]+=-?\d{1,3})*$/

export function pinSpecProblem(spec: string): string | null {
  const trimmed = spec.replace(/\s+/g, '')
  if (!trimmed) {
    return null
  }
  return PIN_SPEC.test(trimmed) ? null : 'Write each pin as name=GPIO, separated by commas, like rst=5,dc=4,cs=3.'
}

export interface StandaloneChoices {
  board: string
  /** The panel, for "Other ESP32-S3 board" and the carrier boards. */
  panel: string
  /** A `set pins` override, for "Other ESP32-S3 board"; empty keeps the XIAO's. */
  pins: string
  name: string
  timeZone: string | null
  wifi: { ssid: string; password: string } | null
}

/** What still has to be chosen before a flash, or null. */
export function standaloneProblem(choices: StandaloneChoices): string | null {
  const board = standaloneBoard(choices.board)
  if (!board && choices.board !== CUSTOM_BOARD) {
    return 'Choose a board.'
  }
  if (choices.board === CUSTOM_BOARD && !choices.panel) {
    return 'Choose the panel.'
  }
  if (choices.board === CUSTOM_BOARD) {
    const problem = pinSpecProblem(choices.pins)
    if (problem) {
      return problem
    }
  }
  if (choices.wifi && /[\r\n\0]/.test(choices.wifi.ssid + choices.wifi.password)) {
    return 'The Wi-Fi name or password has a character the board cannot use.'
  }
  return null
}

function setting(key: EmbeddedUsbConfigKey, value: string, secret = false) {
  return { key, value, secret }
}

/**
 * The console commands that make a stock release image this standalone frame,
 * in order: the board bundle first (`set hardware` applies panel, wiring,
 * buttons, SD slot and battery sensing in one), then what overrides it.
 * No `backend`, no `cloud_url`: a frame with no plane.
 */
export function standaloneProvisioning(choices: StandaloneChoices): ProvisioningCommands {
  const settings = []
  const board = standaloneBoard(choices.board)
  if (board) {
    settings.push(setting('hardware', board.key))
    if (board.panelSelectable && choices.panel && choices.panel !== board.defaultPanel) {
      // After `set hardware`, which sets the carrier's default panel.
      settings.push(setting('panel', choices.panel))
    }
    if (board.rotate !== null) {
      settings.push(setting('rotate', String(board.rotate)))
    }
  } else {
    settings.push(setting('panel', choices.panel))
    const pins = choices.pins.replace(/\s+/g, '')
    if (pins) {
      settings.push(setting('pins', pins))
    }
  }
  settings.push(setting('hostname', standaloneHostname(choices.name)))
  if (choices.timeZone) {
    settings.push(setting('time_zone', choices.timeZone))
  }
  return {
    settings,
    wifi: choices.wifi && choices.wifi.ssid ? { ssid: choices.wifi.ssid, password: choices.wifi.password } : null,
  }
}

// ----- Starter scenes -------------------------------------------------------
//
// The samples are sampleCatalog.ts's index (every repo sample a standalone
// frame can run), ticked one by one or a preset at a time. The Scene store is
// always among them: with it the frame installs the rest without a cable.

/** What the scene list needs to know of the board picked. */
export interface StandaloneBoardKind {
  /** It takes taps: a touch screen (TOUCH_PRESETS). */
  touch: boolean
  /** A fast screen; null before a board is picked. */
  fast: boolean | null
  /** Its flash, which decides its `/state`; null when not known (another S3 board). */
  flashSize: string | null
}

export function standaloneBoardKind(board: string): StandaloneBoardKind {
  const preset = standaloneBoard(board)
  if (preset) {
    return { touch: preset.touch, fast: preset.fast, flashSize: preset.flashSize }
  }
  // Another S3 board: its panels are all e-paper; its flash is read only once
  // the flash starts.
  return { touch: false, fast: board === CUSTOM_BOARD ? false : null, flashSize: null }
}

/** The `state` partition of each flash layout (embedded/esp32/partitions*.csv). */
const STATE_PARTITION_BYTES: Record<string, number> = {
  '4MB': 512 * 1024,
  '8MB': 1024 * 1024,
  '16MB': 8 * 1024 * 1024,
  '32MB': 24 * 1024 * 1024,
}

/** A set holds up to this many scenes (FOS_SCENE_STORE_SCENES, embedded/esp32/README.md "How big a set may be"). */
export const STANDALONE_MAX_SCENES = 128

/** The share of `/state` a set may take: SPIFFS keeps its own pages, and the
 * scenes keep their state beside them (a reTerminal E1002 held 680 KB of
 * scenes on its 1 MB `/state`, with room for 120 KB more). */
const STATE_SHARE_FOR_SCENES = 0.7

export interface StandaloneSceneRoom {
  bytes: number
  /** The flash it was worked out for. */
  flashSize: string
  /** Not known for this board: worked out for the smallest S3 layout. */
  assumed: boolean
}

/** How many bytes of scenes the board keeps. */
export function standaloneSceneRoom(kind: StandaloneBoardKind): StandaloneSceneRoom {
  const flashSize = kind.flashSize && STATE_PARTITION_BYTES[kind.flashSize] ? kind.flashSize : '8MB'
  return {
    bytes: Math.floor(STATE_PARTITION_BYTES[flashSize]! * STATE_SHARE_FOR_SCENES),
    flashSize,
    assumed: flashSize !== kind.flashSize,
  }
}

/** The console reads at 115200 baud on a USB-UART bridge: about 11 KB a second. */
const USB_UPLOAD_BYTES_PER_SECOND = 11 * 1024
/** Scene JSON goes deflated (`usb_api scenes-deflated`): the samples come to
 * a third or a quarter of their size. */
const USB_DEFLATE_RATIO = 3.5
/** What the board takes to store each scene: its slot file made, which on
 * SPIFFS walks the whole partition three times (half a second each on the
 * 32 MB boards' 24 MB `/state`, embedded/esp32/README.md "What still costs"),
 * so it grows with `/state`; and its bytes written. 105 scenes of 4.2 MB took
 * 302 s on the reTerminal Sticky, 100 s of it on the cable (2026-11-25). */
const USB_SCENE_STORE_SECONDS = 0.1
const USB_SCENE_STORE_SECONDS_PER_24MB = 1.4
const USB_STORE_SECONDS_PER_KB = 0.01

/** About how long the picked scenes take over the cable and onto a board of
 * `flashSize` (standaloneSceneRoom's), in seconds. */
export function sceneUploadSeconds(bytes: number, scenes: number, flashSize: string): number {
  const state = STATE_PARTITION_BYTES[flashSize] ?? STATE_PARTITION_BYTES['8MB']!
  const perScene = USB_SCENE_STORE_SECONDS + (USB_SCENE_STORE_SECONDS_PER_24MB * state) / (24 * 1024 * 1024)
  return Math.ceil(
    bytes / USB_DEFLATE_RATIO / USB_UPLOAD_BYTES_PER_SECOND +
      scenes * perScene +
      (bytes / 1024) * USB_STORE_SECONDS_PER_KB
  )
}

export type ScenePresetKey = 'starter' | 'interactive' | 'paper' | 'everything' | 'store'

export interface ScenePreset {
  key: ScenePresetKey
  label: string
  description: string
}

export const scenePresets: ScenePreset[] = [
  {
    key: 'starter',
    label: 'A few to start',
    description: 'The Scene store, a clock, the weather and a few tools.',
  },
  {
    key: 'interactive',
    label: 'Interactive LCD scenes',
    description: 'Scenes you tap, type into or play: games, tools and animations.',
  },
  {
    key: 'paper',
    label: 'Best for e-paper',
    description: 'Scenes that change slowly: clocks, calendars, weather, photos and art.',
  },
  { key: 'everything', label: 'Everything', description: 'Every scene that runs on this board.' },
  { key: 'store', label: 'Only the Scene store', description: 'Install scenes later from the frame itself.' },
]

/** The frame's own tools (the scene switcher puts them first). */
const SYSTEM_CATEGORY = 'System'
const DEMOS_CATEGORY = 'Demos & examples'

// "A few to start" is a choice of taste, so a short list by name, in the
// order they go on: a keys-only board boots into the first one that is not
// the store (a clock). The frame's tools (the "System" category) come too on a
// board that takes taps, whose own screen runs them.
const STARTER_SAMPLES = ['Clock', 'Weather']
const STARTER_TOUCH_SAMPLES = ['Files', 'Calculator', 'Terminal app', 'To-do']
const STARTER_KEYS_SAMPLES = ['Word clock', 'Year progress']

function interactive(sample: FlasherSample): boolean {
  return sample.needs.some((need) => need === 'touch' || need === 'keys' || need === 'fast')
}

/** The samples a preset ticks on this board, in the order they are tried.
 * Any sample may go on any board: a fast scene runs on e-paper too (the DVD
 * logo on a fast e-paper, the kitchen sink), so nothing is held back by the
 * panel; the e-paper preset only suggests what changes slowly. */
function presetCandidates(key: ScenePresetKey, samples: FlasherSample[], kind: StandaloneBoardKind): FlasherSample[] {
  const fits = samples.filter((sample) => !sample.store)
  const byName = (names: string[]) =>
    names.map((name) => fits.find((sample) => sample.name === name)).filter((sample) => sample !== undefined)
  switch (key) {
    case 'store':
      return []
    case 'starter':
      return kind.touch
        ? [
            ...byName(STARTER_SAMPLES),
            ...fits.filter((sample) => sample.category === SYSTEM_CATEGORY),
            ...byName(STARTER_TOUCH_SAMPLES),
          ]
        : byName([...STARTER_SAMPLES, ...STARTER_KEYS_SAMPLES])
    case 'interactive':
      return fits.filter((sample) => sample.category !== DEMOS_CATEGORY && interactive(sample))
    case 'paper':
      return fits.filter(
        (sample) => sample.category !== DEMOS_CATEGORY && !interactive(sample) && !sample.needs.includes('fast')
      )
    case 'everything':
      return fits
  }
}

export interface PresetPicks {
  /** The samples ticked: the Scene store first, then the preset's that fit. */
  picked: string[]
  /** The preset's samples that did not fit the board's room. */
  noRoom: string[]
}

/** What a preset ticks: the Scene store, then its samples while the board has room for them. */
export function presetPicks(key: ScenePresetKey, samples: FlasherSample[], kind: StandaloneBoardKind): PresetPicks {
  const room = standaloneSceneRoom(kind)
  const store = samples.filter((sample) => sample.store)
  let bytes = store.reduce((sum, sample) => sum + sample.bytes, 0)
  let count = store.reduce((sum, sample) => sum + sample.scenes, 0)
  const picked = store.map((sample) => sample.name)
  const noRoom: string[] = []
  for (const sample of presetCandidates(key, samples, kind)) {
    if (picked.includes(sample.name)) {
      continue
    }
    if (bytes + sample.bytes > room.bytes || count + sample.scenes > STANDALONE_MAX_SCENES) {
      noRoom.push(sample.name)
      continue
    }
    bytes += sample.bytes
    count += sample.scenes
    picked.push(sample.name)
  }
  return { picked, noRoom }
}

/** The preset a board starts on. */
export function defaultScenePreset(): ScenePresetKey {
  return 'starter'
}

export interface PickedScenes {
  samples: FlasherSample[]
  bytes: number
  scenes: number
}

/** The picked samples in the list's order, the Scene store always among them. */
export function pickedScenes(samples: FlasherSample[], picked: readonly string[]): PickedScenes {
  const chosen = samples.filter((sample) => sample.store || picked.includes(sample.name))
  return {
    samples: chosen,
    bytes: chosen.reduce((sum, sample) => sum + sample.bytes, 0),
    scenes: chosen.reduce((sum, sample) => sum + sample.scenes, 0),
  }
}

/** A size as the list says it: KB, or MB from one. */
export function sceneBytesLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}

/** Why the picked scenes cannot go on the board, or null. */
export function pickedScenesProblem(
  picked: PickedScenes,
  kind: StandaloneBoardKind,
  samples: FlasherSample[] | null
): string | null {
  if (samples === null) {
    return null
  }
  if (picked.scenes > STANDALONE_MAX_SCENES) {
    return `A frame holds at most ${STANDALONE_MAX_SCENES} scenes. Untick some.`
  }
  const room = standaloneSceneRoom(kind)
  if (picked.bytes > room.bytes) {
    return `These scenes take ${sceneBytesLabel(picked.bytes)}, but the board has room for about ${sceneBytesLabel(
      room.bytes
    )}${room.assumed ? ' (if it has 8 MB of flash)' : ''}. Untick some.`
  }
  return null
}

function sceneIsLayout(scene: Record<string, unknown>): boolean {
  const settings = scene.settings
  return !!settings && typeof settings === 'object' && (settings as Record<string, unknown>).isLayout === true
}

/**
 * The scene set a standalone frame starts with: the picked samples' scenes,
 * the Scene store's first. A board that takes taps gets no `default`: with no
 * scene of its own choosing it opens on the scene switcher, its home. A board
 * of keys alone boots into the first scene that is not the store (a clock, not
 * the shop), or the store when it is all there is.
 */
export function starterSceneSet(
  sampleScenes: readonly (readonly Record<string, unknown>[])[],
  kind: Pick<StandaloneBoardKind, 'touch'>
): Record<string, unknown>[] {
  const scenes = sampleScenes.flatMap((scenes) => scenes.map((scene) => ({ ...scene })))
  scenes.sort((a, b) => Number(b.id === SCENE_STORE_ID) - Number(a.id === SCENE_STORE_ID))
  const first = kind.touch
    ? null
    : (scenes.find((scene) => scene.id !== SCENE_STORE_ID && !sceneIsLayout(scene)) ?? scenes[0])
  for (const scene of scenes) {
    if (scene === first) {
      scene.default = true
    } else {
      delete scene.default
    }
  }
  return scenes
}
