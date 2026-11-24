import { EMBEDDED_ESP32_S3 } from '../../../frontend/src/devices'
import { ESP32_HARDWARE_PRESET_CONFIGS } from '../../../frontend/src/scenes/frame/panels/FrameSettings/esp32Hardware'
import type { ProvisioningCommands } from '../../../frontend/src/scenes/workspace/embeddedFlashRun'
import type { EmbeddedUsbConfigKey } from '../../../frontend/src/models/embeddedUsbLogsModel'

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
// "A boot that does not wait for the network"). Keep with the touch presets
// in TOUCH_EDGE_SWIPES (fos_board.c) and the SPA's frameEventMap.ts.
const TOUCH_PRESETS = new Set([
  'seeed_reterminal_sticky',
  'seeed_reterminal_e1003',
  'seeed_sensecap_indicator_d1',
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
  return PIN_SPEC.test(trimmed) ? null : 'Pins are written as rst=5,dc=4,cs=3,… (a name, an equals sign, a GPIO).'
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
    return 'Pick the board.'
  }
  if (choices.board === CUSTOM_BOARD && !choices.panel) {
    return 'Pick the panel wired to the board.'
  }
  if (choices.board === CUSTOM_BOARD) {
    const problem = pinSpecProblem(choices.pins)
    if (problem) {
      return problem
    }
  }
  if (choices.wifi && /[\r\n\0]/.test(choices.wifi.ssid + choices.wifi.password)) {
    return 'The Wi-Fi name or password has a character the board cannot take.'
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

/** One sample the flasher offers (cloud-frontend/build.mjs writes the list
 * from repo/scenes/samples into flasher-scenes.json). */
export interface StarterTemplate {
  name: string
  description: string
  /** Ticked unless the person unticks it. */
  preselected: boolean
  scenes: Record<string, unknown>[]
}

/**
 * The scene set a standalone frame starts with: the picked samples' scenes,
 * the first one that is not the Scene store marked `default` (the frame shows
 * a clock, not the shop), the store itself always among them so the frame
 * can install the rest without a cable.
 */
export function starterSceneSet(templates: StarterTemplate[], picked: ReadonlySet<string>): Record<string, unknown>[] {
  const scenes = templates
    .filter((template) => picked.has(template.name))
    .flatMap((template) => template.scenes.map((scene) => ({ ...scene })))
  const first = scenes.find((scene) => scene.id !== 'scene-store') ?? scenes[0]
  for (const scene of scenes) {
    if (scene === first) {
      scene.default = true
    } else {
      delete scene.default
    }
  }
  return scenes
}
