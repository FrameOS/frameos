// What is different about a Raspberry Pi Pico W / Pico 2 W frame (the
// Pimoroni Inky Frame family) in the deploy drawer. Pure — no React, no kea,
// no serial port — so it is testable on its own
// (cloud/apps/auth-web/src/test/shared-spa/pico-firmware.test.ts).
//
// A Pico runs the same kind of generic signed release as an ESP32 and speaks
// the same `usb_api` console, so identifying the board, applying this frame's
// settings, Wi-Fi, restart and factory reset are the ESP32 card's code
// unchanged. What it does NOT have is any way for a browser to write its
// flash: there is no esptool and no ROM serial loader, only the UF2
// bootloader — a USB drive the person drags a file onto. So every affordance
// that ends in esptool (flash a blank board, update around NVS, erase and
// start over, the by-hand esptool recipe) is off, and in its place the drawer
// offers the .uf2 as a download plus `usb_api bootsel`, which reboots a board
// that already runs FrameOS into that drive.
//
// Self-hosted backend only: FrameOS Cloud lists no pico assets and cannot
// render for a thin client yet (docs/convergence-todo.md §3).
import { isPicoPlatform } from './workspaceSurfaces'

export { isPicoPlatform }

/**
 * Whether this frame's release image is a UF2. The provisioning plan says so
 * outright (`releaseFormat`); a plan that has not loaded yet, a backend that
 * predates the field and the cloud (which has no such field) fall back to the
 * platform name.
 */
export function isUf2Release(releaseFormat: string | null | undefined, platform: unknown): boolean {
  return releaseFormat === 'uf2' || (!releaseFormat && isPicoPlatform(platform))
}

export interface UsbCardAffordances {
  /** Flash a blank/silent board from the browser (EmbeddedReleaseFlasher). */
  browserFlash: boolean
  /** Write a new release around the settings partition (EmbeddedUsbFirmwareUpdate). */
  firmwareUpdateOverUsb: boolean
  /** "Erase & flash FrameOS again". */
  eraseAndReflash: boolean
  /** The by-hand esptool recipe. */
  manualEsptoolCommand: boolean
  /** `usb_api bootsel`: reboot into the UF2 drive. */
  rebootIntoBootsel: boolean
}

/** Which flashing affordances the "Connect over USB" card offers. Everything
 * that is not flashing (settings, Wi-Fi, restart, factory reset) is the same
 * on both families and is not listed here. */
export function usbCardAffordances(uf2: boolean): UsbCardAffordances {
  return {
    browserFlash: !uf2,
    firmwareUpdateOverUsb: !uf2,
    eraseAndReflash: !uf2,
    manualEsptoolCommand: !uf2,
    rebootIntoBootsel: uf2,
  }
}

/** The name the UF2 bootloader's drive mounts under: RP2350 on a Pico 2 W,
 * RPI-RP2 on the original (RP2040) Pico W. */
export function bootselDriveName(platform: unknown): string {
  return typeof platform === 'string' && platform.toLowerCase().startsWith('pico-2') ? 'RP2350' : 'RPI-RP2'
}

/** "Pico 2 W" / "Pico W", for copy. */
export function picoBoardLabel(platform: unknown): string {
  return typeof platform === 'string' && platform.toLowerCase().startsWith('pico-2') ? 'Pico 2 W' : 'Pico W'
}

export interface Uf2ListingAsset {
  name: string
  platform: string
  size: number
  /** "bin" | "uf2" | "img.gz"; absent on a listing that predates the field. */
  format?: string
}

/**
 * The .uf2 this frame wants out of `/api/frames/firmware`, or null when the
 * latest release does not publish one (it predates the pico build). A listing
 * without `format` is judged by the file name, so an older backend still
 * offers the download rather than claiming nothing exists.
 */
export function pickUf2Asset<T extends Uf2ListingAsset>(
  assets: readonly T[] | null | undefined,
  platform: string | null | undefined
): T | null {
  if (!platform) {
    return null
  }
  return (
    (assets ?? []).find(
      (asset) =>
        asset.platform === platform &&
        (asset.format === 'uf2' || (asset.format === undefined && asset.name.toLowerCase().endsWith('.uf2')))
    ) ?? null
  )
}

/** "1.4 MB" / "612 KB" for a release asset. */
export function firmwareSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return ''
  }
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * The file name to save a firmware response under: the backend names it twice
 * (`x-frameos-image-name`, and the `content-disposition` attachment), and the
 * listing's asset name is the fallback when a proxy stripped both. Path
 * separators never survive — the name goes straight into a download.
 */
export function firmwareDownloadFileName(headers: { get(name: string): string | null }, fallback: string): string {
  const disposition = headers.get('content-disposition') ?? ''
  const quoted = disposition.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
  const bare = disposition.match(/filename\s*=\s*([^";\s]+)/i)?.[1]
  const candidates = [headers.get('x-frameos-image-name'), quoted, bare, fallback]
  for (const candidate of candidates) {
    const name = (candidate ?? '').trim().split(/[\\/]/).pop() ?? ''
    if (name && name !== '.' && name !== '..') {
      return name
    }
  }
  return 'frameos.uf2'
}

/**
 * Why the board on the cable cannot be this frame, when its firmware reports a
 * chip family (`status.board.target`) that does not match the frame's
 * platform: a Pico answering in an ESP32 frame's drawer, or the other way
 * round. Null when they agree or the board does not say.
 */
export function usbBoardFamilyMismatch(framePlatform: unknown, boardTarget: unknown): string | null {
  if (typeof boardTarget !== 'string' || !boardTarget.trim() || typeof framePlatform !== 'string' || !framePlatform) {
    return null
  }
  if (isPicoPlatform(framePlatform) === isPicoPlatform(boardTarget)) {
    return null
  }
  return `This board reports itself as ${boardTarget}, but this frame is set up for ${framePlatform}. Check the frame's platform under Settings before sending it anything.`
}
