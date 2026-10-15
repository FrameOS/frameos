import type { ComponentType } from 'react'

import type { FrameType } from '../../types'

// How the cloud bundle hands its own components to the shared workspace.
//
// frontend/src is compiled into three bundles — the self-hosted backend, the
// on-device admin panel and FrameOS Cloud (cloud-frontend/, which deep-imports
// these files). An `import ... from '../../../cloud-frontend/...'` here would
// therefore drag cloud-only code (and its deps) into the other two, so the
// dependency only ever points inward: the cloud bundle registers its panels at
// startup (see cloud-frontend/src/main.tsx) and the shared components render
// whatever is registered.
//
// Module-level state rather than kea: registration happens once, before the
// first render, and never changes for the lifetime of the page.
let registeredPanel: ComponentType | null = null

export function registerAddFramePanel(panel: ComponentType): void {
  registeredPanel = panel
}

/** The registered panel, or null in a bundle that never registered one. */
export function registeredAddFramePanel(): ComponentType | null {
  return registeredPanel
}

// The first-run panel: what the frames home shows in the middle of the
// workspace when the fleet has loaded and is empty. The cloud registers its
// enrollment panel (the same one its "Add frame" drawer hosts) so a new
// account lands on the ways to add a frame instead of an empty page, with
// the rail and the frame tree around it like on every other page.
let registeredFirstRun: ComponentType | null = null

export function registerFirstRunPanel(panel: ComponentType): void {
  registeredFirstRun = panel
}

/** The registered first-run panel, or null in a bundle without one. */
export function registeredFirstRunPanel(): ComponentType | null {
  return registeredFirstRun
}

/**
 * Panels the deploy drawer shows for ONE frame, keyed by slot.
 *
 * Both current entries are enrollment operations on a frame that already
 * exists — they mint a claim token bound to it, which only the cloud can do:
 *
 *   usbRelink   re-flash a wiped ESP32 back onto this frame (it used to be a
 *               fifth entry in "Add frame", which put an operation on an
 *               existing frame inside the flow for creating one)
 *   sdImage     build another Raspberry Pi SD card for this frame, so a dead
 *               card or a replacement Pi does not mean abandoning it
 *
 * They live in the deploy drawer because that is where you already are when
 * the hardware is the problem.
 */
export type FramePanelSlot = 'usbRelink' | 'sdImage'

export type FramePanel = ComponentType<{ frame: FrameType }>

const registeredFramePanels: Partial<Record<FramePanelSlot, FramePanel>> = {}

export function registerFramePanel(slot: FramePanelSlot, panel: FramePanel): void {
  registeredFramePanels[slot] = panel
}

/** The panel registered for this slot, or null outside the cloud bundle. */
export function registeredFramePanel(slot: FramePanelSlot): FramePanel | null {
  return registeredFramePanels[slot] ?? null
}
