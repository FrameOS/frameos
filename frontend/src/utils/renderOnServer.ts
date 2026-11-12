// Where an ESP32's scenes run (docs/server-rendering.md): on the frame's own
// runtime, or on its control plane, which hands it the finished picture.
// Pure and import-free beyond types, so the cloud's shared-spa tests run it
// in node.
import type { FrameType, RenderMode } from '../types'

// Each helper takes the few fields it reads, every one of them optional and
// allowed to be undefined: the settings form passes form values as they are.
type Fields<K extends keyof FrameType> = { [P in K]?: FrameType[P] | undefined }

// What the backend reads as remote (embedded_render_mode_for_frame in
// backend/app/tasks/embedded_firmware.py): `remote` and three old aliases.
const remoteSpellings = new Set(['remote', 'thin_client', 'thinclient', 'backend'])
const localSpellings = new Set(['local', 'on_device', 'ondevice'])

/** A stored render mode in any of its spellings, or undefined when unset or unknown. */
export function normalizeRenderMode(value: unknown): RenderMode | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim().toLowerCase().replace(/-/g, '_')
  if (remoteSpellings.has(normalized)) {
    return 'remote'
  }
  if (localSpellings.has(normalized)) {
    return 'local'
  }
  return undefined
}

// Boards without a runtime of their own: the plane renders every picture
// for them whatever the setting says (cloud-rendered.ts on the cloud,
// isThinClientEmbeddedPlatform on the backend).
const thinPlatformPrefixes = ['esp32-c3', 'pico', 'virtual']

/**
 * Whether the board the frame reported can run its own scenes: an ESP32-S3
 * can, a C3, a Pico and a virtual frame cannot. A frame that never reported
 * its hardware is given the benefit of the doubt.
 */
export function frameCanRenderItself(hardware: FrameType['hardware'] | null | undefined): boolean {
  if (!hardware) {
    return true
  }
  if (hardware.localRenderSupported === false) {
    return false
  }
  const platform = typeof hardware.platform === 'string' ? hardware.platform.toLowerCase() : ''
  return !thinPlatformPrefixes.some((prefix) => platform.startsWith(prefix))
}

/** The render mode a backend frame is set to, from its device_config. */
export function backendFrameRenderMode(frame: Fields<'device_config' | 'embedded'>): RenderMode {
  for (const source of [frame.device_config, frame.embedded] as const) {
    if (source && typeof source === 'object') {
      const record = source as Record<string, unknown>
      const mode = normalizeRenderMode(record.renderMode ?? record.render_mode)
      if (mode) {
        return mode
      }
    }
  }
  return 'local'
}

/** The render mode a cloud frame is set to: the owner's setting, else what the device reports. */
export function cloudFrameRenderMode(frame: Fields<'render_mode' | 'hardware'>): RenderMode {
  return normalizeRenderMode(frame.render_mode) ?? normalizeRenderMode(frame.hardware?.renderMode) ?? 'local'
}

/**
 * Whether the frame renders its own scenes now and could hand them to its
 * plane instead: an ESP32 with a runtime, set to render locally. What the
 * battery popover offers rendering on the server to.
 */
export function frameCouldRenderOnServer(
  frame: Fields<'mode' | 'hardware' | 'render_mode' | 'device_config' | 'embedded'>,
  plane: 'cloud' | 'backend'
): boolean {
  if (plane === 'cloud') {
    const platform = (frame.hardware?.platform ?? '').toLowerCase()
    return (
      platform.startsWith('esp32') && frameCanRenderItself(frame.hardware) && cloudFrameRenderMode(frame) === 'local'
    )
  }
  if (frame.mode !== 'embedded') {
    return false
  }
  const platform = (frame.embedded?.platform ?? 'esp32-s3').toLowerCase()
  if (!platform.startsWith('esp32') || thinPlatformPrefixes.some((prefix) => platform.startsWith(prefix))) {
    return false
  }
  return backendFrameRenderMode(frame) === 'local'
}

/**
 * Whether the frame's plane runs its scenes now: a board without a runtime,
 * or an ESP32 set to render on the server. Such a board is sent none of its
 * scenes and none of the account's keys (docs/server-rendering.md "Nothing to
 * keep on the board"), so nothing offers to copy them onto it either. A
 * virtual frame is not one: it has no board.
 */
export function frameRendersOnServer(
  frame: Fields<'mode' | 'hardware' | 'render_mode' | 'device_config' | 'embedded'>,
  plane: 'cloud' | 'backend'
): boolean {
  if (plane === 'cloud') {
    const platform = (frame.hardware?.platform ?? '').toLowerCase()
    if (platform.startsWith('virtual')) {
      return false
    }
    // The owner's setting alone, as the cloud reads it (cloud-rendered.ts
    // settingsRenderOnServer): a board's own word is not what it is sent by.
    return !frameCanRenderItself(frame.hardware) || normalizeRenderMode(frame.render_mode) === 'remote'
  }
  if (frame.mode !== 'embedded') {
    return false
  }
  const platform = (frame.embedded?.platform ?? 'esp32-s3').toLowerCase()
  if (platform.startsWith('virtual')) {
    return false
  }
  return (
    thinPlatformPrefixes.some((prefix) => platform.startsWith(prefix)) || backendFrameRenderMode(frame) === 'remote'
  )
}
