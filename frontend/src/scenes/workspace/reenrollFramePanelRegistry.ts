import type { ComponentType } from 'react'
import type { FrameId } from '../../utils/frameId'

// How the cloud bundle hands its "re-enroll this board" panel to the shared
// workspace, exactly like addFramePanelRegistry does for "Add frame".
//
// The dependency only ever points inward: frontend/src builds three bundles
// (self-hosted backend, on-device admin, FrameOS Cloud), and importing
// cloud-frontend/ from here would drag cloud-only code into the other two.
// The cloud bundle registers its panel at startup (cloud-frontend/src/main.tsx)
// and the deploy drawer renders whatever is registered.
//
// Re-enrollment re-keys an EXISTING frame: the board comes back from a factory
// reset or a full 0x0 flash with a new device keypair and no link token, and
// the panel provisions a claim token bound to this frame id so the workspace
// keeps the same row (with its scenes, assets and logs) instead of forking a
// duplicate.
export interface ReenrollFramePanelProps {
  // Opaque, as everywhere in the shared SPA: the backend numbers its frames
  // and the cloud uses uuids. Only the cloud bundle registers a panel, so in
  // practice this is always a uuid — but never parse it.
  frameId: FrameId
  frameName: string
}

let registeredPanel: ComponentType<ReenrollFramePanelProps> | null = null

export function registerReenrollFramePanel(panel: ComponentType<ReenrollFramePanelProps>): void {
  registeredPanel = panel
}

/** The registered panel, or null in a bundle that never registered one. */
export function registeredReenrollFramePanel(): ComponentType<ReenrollFramePanelProps> | null {
  return registeredPanel
}
