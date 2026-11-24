// flash.frameos.net and the pages that hand it their USB work
// (cloud/docs/flasher.md).
//
// Browsers offer Web Serial only on a secure page (https://, or http:// on
// localhost) and only to a frame the permission is delegated to. A
// self-hosted backend reached as http://192.168.1.10:8989 — or a Home
// Assistant add-on on http://homeassistant.local:8123 — is neither, so it
// cannot talk to a board on its own. A window it opens on an https page CAN
// (the window is its own top-level page; checked in Chromium, 2026-11-24),
// and the two talk with postMessage, which works between any two origins.
// So the backend's page opens flash.frameos.net, hands it the frame's setup
// document (and, on request, the release image it downloaded itself), and the
// flasher does the USB part and reports back.
//
// What makes it safe to hand over:
//   * the page posts the job ONLY to the window it opened, with the
//     flasher's origin as the target, so the frame's API key and Wi-Fi
//     password reach nothing else even if that window navigated away;
//   * the flasher acts on nothing until a person clicks and picks the port,
//     and shows which page asked and what it will write first;
//   * every image it writes is checked against the FrameOS release
//     signature, wherever the bytes came from (releaseFirmware.ts), so a
//     page that opens the flasher cannot make it write anything else.
//
// The same document is the "setup file" a backend downloads for the flasher
// on another computer (backend `GET /api/frames/{id}/embedded/setup`).

import type { EmbeddedProvisioningPlan } from '../scenes/workspace/embeddedFlashRun'
import type { ReleaseFirmwareListing } from '../scenes/workspace/releaseFirmware'

export const FLASHER_BRIDGE_PROTOCOL = 'frameos-flasher'
export const FLASHER_BRIDGE_VERSION = 1
export const DEFAULT_FLASHER_URL = 'https://flash.frameos.net'
export const FRAME_SETUP_FORMAT = 'frameos-setup'
export const FRAME_SETUP_VERSION = 1

/** Where this page's flasher is: the backend's FRAMEOS_FLASHER_URL
 * (`flasher_url` in its app config), else flash.frameos.net. */
export function flasherUrl(): string {
  const configured =
    typeof window !== 'undefined' ? (window as any).FRAMEOS_APP_CONFIG?.flasher_url : (undefined as unknown)
  if (typeof configured === 'string' && /^https?:\/\//i.test(configured.trim())) {
    return configured.trim().replace(/\/+$/, '')
  }
  return DEFAULT_FLASHER_URL
}

export function flasherOrigin(url: string = flasherUrl()): string {
  return new URL(url).origin
}

/** The address a bridge job opens: `?bridge=1` tells the flasher to wait for
 * the page that opened it. */
export function flasherBridgeUrl(url: string = flasherUrl()): string {
  const target = new URL(url)
  target.searchParams.set('bridge', '1')
  return target.toString()
}

// ----- The setup document ---------------------------------------------------

export interface FrameSetupDocument {
  format: typeof FRAME_SETUP_FORMAT
  version: number
  createdAt?: string
  frame: { id: number | string; name: string }
  /** Where the frame will call home: the plan's `backend` setting. */
  backend?: { url: string | null }
  provisioning: EmbeddedProvisioningPlan
  /** What the board's own pull would get. */
  scenes: unknown[]
}

export class FrameSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameSetupError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// What a console key may be: what `usb_api set` takes (fos_console.c
// cmd_set), a word. A file can hold anything; the console line must not.
const CONSOLE_KEY = /^[a-z][a-z0-9_]{0,40}$/
// The keys a setup may never carry: they make the board somebody's cloud
// frame, which is the cloud's own enrollment (a claim token it mints), never
// a file or a page's.
const REFUSED_KEYS = new Set(['cloud_url', 'cloud_wsurl', 'claim_token'])

/**
 * Read a setup document (a file someone dropped, or a bridge job) and refuse
 * anything that is not one. Never trusts what it was given: every console
 * setting is a known shape, nothing has a line break, no cloud enrollment.
 */
export function parseFrameSetupDocument(value: unknown): FrameSetupDocument {
  if (!isRecord(value) || value.format !== FRAME_SETUP_FORMAT) {
    throw new FrameSetupError('This is not a FrameOS setup file.')
  }
  if (typeof value.version !== 'number' || value.version > FRAME_SETUP_VERSION) {
    throw new FrameSetupError(
      'This setup file is from a newer FrameOS than this flasher knows. Reload the page and try again.'
    )
  }
  const frame = value.frame
  if (!isRecord(frame) || (typeof frame.id !== 'number' && typeof frame.id !== 'string')) {
    throw new FrameSetupError('The setup file does not say which frame it is for.')
  }
  const name = typeof frame.name === 'string' && frame.name.trim() ? frame.name.trim() : `Frame ${frame.id}`
  const provisioning = value.provisioning
  if (!isRecord(provisioning) || !Array.isArray(provisioning.settings)) {
    throw new FrameSetupError('The setup file has no settings for the board.')
  }
  const settings = provisioning.settings.map((setting) => {
    if (
      !isRecord(setting) ||
      typeof setting.key !== 'string' ||
      !CONSOLE_KEY.test(setting.key) ||
      typeof setting.value !== 'string' ||
      /[\r\n\0]/.test(setting.value)
    ) {
      throw new FrameSetupError('The setup file has a setting the board could not take.')
    }
    if (REFUSED_KEYS.has(setting.key)) {
      throw new FrameSetupError(
        `The setup file sets ${setting.key}: a board joins FrameOS Cloud from the cloud's own flasher, not from a file.`
      )
    }
    return { key: setting.key, value: setting.value, secret: setting.secret === true }
  })
  let wifi: { ssid: string; password: string } | null = null
  if (isRecord(provisioning.wifi)) {
    const { ssid, password } = provisioning.wifi
    if (typeof ssid !== 'string' || typeof password !== 'string' || /[\r\n\0]/.test(ssid + password)) {
      throw new FrameSetupError('The setup file has a Wi-Fi network the board could not take.')
    }
    if (ssid) {
      wifi = { ssid, password }
    }
  }
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : []
  const optionalString = (input: unknown): string | null => (typeof input === 'string' && input ? input : null)
  const releaseFormat = provisioning.releaseFormat
  const scenes = value.scenes
  if (scenes !== undefined && !Array.isArray(scenes)) {
    throw new FrameSetupError('The setup file’s scenes are not a list.')
  }
  const backend = isRecord(value.backend) ? { url: optionalString(value.backend.url) } : undefined
  return {
    format: FRAME_SETUP_FORMAT,
    version: value.version,
    ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
    frame: { id: frame.id, name },
    ...(backend ? { backend } : {}),
    provisioning: {
      supported: provisioning.supported !== false,
      platform: typeof provisioning.platform === 'string' ? provisioning.platform : '',
      releasePlatform: optionalString(provisioning.releasePlatform),
      releaseFlashSize: optionalString(provisioning.releaseFlashSize),
      releaseFormat: releaseFormat === 'bin' || releaseFormat === 'uf2' ? releaseFormat : null,
      blockers: strings(provisioning.blockers),
      warnings: strings(provisioning.warnings),
      settings: settings as EmbeddedProvisioningPlan['settings'],
      wifi,
    },
    scenes: scenes ?? [],
  }
}

/** The file name "Download setup file" saves under. */
export function frameSetupFileName(frameName: string): string {
  const slug =
    frameName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'frame'
  return `${slug}.frameos-setup.json`
}

// ----- The bridge's messages ------------------------------------------------

export type FlasherJobKind =
  /** A blank board: the release image, then this frame's settings. */
  | 'setup'
  /** A board that is this frame: the release around its settings. */
  | 'update'
  /** No flash: this frame's settings over the console (a Pico's step 2). */
  | 'provision'

export interface FlasherJob {
  kind: FlasherJobKind
  setup: FrameSetupDocument
  /** `update`: push the setup's scenes once the board is back. */
  pushScenes?: boolean
  /** `provision`: send the Wi-Fi too (a Pico, which is never flashed). */
  withWifi?: boolean
}

export type FlasherPhase = 'idle' | 'connecting' | 'preparing' | 'flashing' | 'done' | 'error'

export type FlasherToOpener =
  | { type: 'ready' }
  | { type: 'listing-request'; id: number }
  | { type: 'image-request'; id: number; platform: string }
  | { type: 'status'; phase: FlasherPhase; message: string | null; progress: number | null }
  | { type: 'log'; line: string }
  | { type: 'flash-size'; flashSize: string }
  | { type: 'scenes-uploaded' }
  | { type: 'finished'; outcome: 'done' | 'written' | 'failed' | 'cancelled'; message: string | null }

export type OpenerToFlasher =
  | { type: 'job'; job: FlasherJob }
  | { type: 'listing'; id: number; listing: ReleaseFirmwareListing }
  | {
      type: 'image'
      id: number
      name: string
      release: string
      bytes: ArrayBuffer
      /** The image's .minisig; null when the opener's plane has none. */
      minisig: string | null
    }
  | { type: 'error'; id: number; message: string }

type Envelope<T> = T & { protocol: typeof FLASHER_BRIDGE_PROTOCOL; version: number }

export function bridgeMessage<T extends FlasherToOpener | OpenerToFlasher>(message: T): Envelope<T> {
  return { protocol: FLASHER_BRIDGE_PROTOCOL, version: FLASHER_BRIDGE_VERSION, ...message }
}

const FLASHER_TYPES = new Set([
  'ready',
  'listing-request',
  'image-request',
  'status',
  'log',
  'flash-size',
  'scenes-uploaded',
  'finished',
])
const OPENER_TYPES = new Set(['job', 'listing', 'image', 'error'])

function bridgeEnvelope(data: unknown, types: Set<string>): Record<string, unknown> | null {
  if (
    !isRecord(data) ||
    data.protocol !== FLASHER_BRIDGE_PROTOCOL ||
    data.version !== FLASHER_BRIDGE_VERSION ||
    typeof data.type !== 'string' ||
    !types.has(data.type)
  ) {
    return null
  }
  return data
}

/** A message from the flasher, or null for anything else on the channel. */
export function readFlasherMessage(data: unknown): FlasherToOpener | null {
  const message = bridgeEnvelope(data, FLASHER_TYPES)
  if (!message) {
    return null
  }
  if ((message.type === 'listing-request' || message.type === 'image-request') && typeof message.id !== 'number') {
    return null
  }
  if (
    message.type === 'image-request' &&
    (typeof message.platform !== 'string' || !/^[a-z0-9-]{1,40}$/.test(message.platform))
  ) {
    return null
  }
  if (message.type === 'log' && typeof message.line !== 'string') {
    return null
  }
  if (
    message.type === 'flash-size' &&
    (typeof message.flashSize !== 'string' || !/^\d{1,3}MB$/.test(message.flashSize))
  ) {
    return null
  }
  return message as unknown as FlasherToOpener
}

/** A message from the page that opened the flasher, or null. */
export function readOpenerMessage(data: unknown): OpenerToFlasher | null {
  const message = bridgeEnvelope(data, OPENER_TYPES)
  if (!message) {
    return null
  }
  if (message.type !== 'job' && typeof message.id !== 'number') {
    return null
  }
  if (message.type === 'image' && !(message.bytes instanceof ArrayBuffer)) {
    return null
  }
  return message as unknown as OpenerToFlasher
}
