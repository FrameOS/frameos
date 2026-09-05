// What a board plugged in over USB turns out to be, relative to the frame
// whose deploy drawer is open — the one decision the "Connect over USB" card
// makes before it shows anything. Pure over the `usb_api status` JSON so it
// is testable without a serial port
// (cloud/apps/auth-web/src/test/shared-spa/usb-board-identity.test.ts).
//
// The board itself already says which of the old three USB cards applies:
// a board whose console never answers is blank (or in ROM download mode) and
// wants the release flashed and provisioned; a FrameOS board with no frame
// configured wants provisioning; a board that is this frame wants firmware
// kept in step and settings applied; a board that is some other frame must
// be re-provisioned only on an explicit say-so.
import type { EmbeddedUsbStatus } from '../../models/embeddedUsbLogsModel'
import type { FrameType } from '../../types'
import type { WorkspaceMode } from './workspaceSurfaces'

export type UsbBoardIdentity =
  /** The console never answered: a blank board, foreign firmware, or ROM download mode. */
  | { kind: 'silent'; detail: string }
  /** Runs FrameOS but is set up for no frame on any control plane. */
  | { kind: 'unprovisioned'; status: EmbeddedUsbStatus }
  /** Runs FrameOS as the frame this drawer belongs to. */
  | { kind: 'this-frame'; status: EmbeddedUsbStatus }
  /** Runs FrameOS as a different frame (another row, another backend, or a cloud enrollment). */
  | { kind: 'other-frame'; status: EmbeddedUsbStatus; label: string }

/** `host:port` of a backend URL as the device stores it, so two spellings of
 * the same backend ("http://10.0.0.5:8989" vs "10.0.0.5:8989/") compare equal.
 * Empty when there is no host. */
export function backendHostPort(url: string | null | undefined): string {
  const trimmed = (url ?? '').trim()
  if (!trimmed) {
    return ''
  }
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
    if (!parsed.hostname) {
      return ''
    }
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    return `${parsed.hostname.toLowerCase()}:${port}`
  } catch {
    return ''
  }
}

export function classifyUsbBoard(
  frame: Pick<FrameType, 'id'>,
  status: EmbeddedUsbStatus | null,
  mode: WorkspaceMode,
  // The backend URL this frame's provisioning plan would send (`set backend`),
  // when the caller has it: two backends both have a frame 1, so a matching
  // numeric id alone does not make a board this frame.
  expectedBackendUrl?: string | null,
  silentDetail = 'The board did not answer as a FrameOS device.'
): UsbBoardIdentity {
  if (!status) {
    return { kind: 'silent', detail: silentDetail }
  }
  const cloudFrameId = typeof status.cloud?.frameId === 'string' ? status.cloud.frameId.trim() : ''
  const configFrameId = typeof status.config?.frameId === 'number' ? status.config.frameId : 0
  const backendUrl = typeof status.config?.backendUrl === 'string' ? status.config.backendUrl.trim() : ''

  if (mode === 'cloud') {
    if (cloudFrameId && cloudFrameId === String(frame.id)) {
      return { kind: 'this-frame', status }
    }
    if (cloudFrameId) {
      return { kind: 'other-frame', status, label: `a different cloud frame (${cloudFrameId.slice(0, 8)}…)` }
    }
    if (configFrameId || backendUrl) {
      return {
        kind: 'other-frame',
        status,
        label: `frame #${configFrameId || '?'} on the self-hosted backend ${backendHostPort(backendUrl) || backendUrl}`,
      }
    }
    return { kind: 'unprovisioned', status }
  }

  // Self-hosted backend (and a device's own admin bundle, which has no plan).
  const idMatches = configFrameId !== 0 && String(configFrameId) === String(frame.id)
  const expected = backendHostPort(expectedBackendUrl)
  const backendMatches = !expected || !backendUrl || backendHostPort(backendUrl) === expected
  if (idMatches && backendMatches && (backendUrl || !expected)) {
    return { kind: 'this-frame', status }
  }
  if (configFrameId || backendUrl) {
    return {
      kind: 'other-frame',
      status,
      label: `frame #${configFrameId || '?'} on ${backendHostPort(backendUrl) || backendUrl || 'an unknown backend'}`,
    }
  }
  if (cloudFrameId) {
    return { kind: 'other-frame', status, label: `a cloud-managed frame (${cloudFrameId.slice(0, 8)}…)` }
  }
  return { kind: 'unprovisioned', status }
}

/** "2026.9.9" from "v2026.9.9" / "2026.9.9"; null when unknown. */
export function normalizedFirmwareVersion(value?: string | null): string | null {
  const trimmed = (value ?? '').trim().replace(/^v/i, '')
  return trimmed || null
}

/** The message the probe throws when the board simply does not answer, as
 * opposed to a port that could not be opened or a payload that made no sense. */
export function isUsbSilenceError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error)
  return /Timed out waiting for USB command (?:response|ready)/i.test(detail)
}
