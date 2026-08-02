import type { ComponentType } from 'react'

// How the cloud bundle hands its "Add frame" drawer to the shared workspace.
//
// frontend/src is compiled into three bundles — the self-hosted backend, the
// on-device admin panel and FrameOS Cloud (cloud-frontend/, which deep-imports
// these files). An `import ... from '../../../cloud-frontend/...'` here would
// therefore drag cloud-only code (and its deps) into the other two, so the
// dependency only ever points inward: the cloud bundle registers its panel at
// startup (see cloud-frontend/src/main.tsx) and FramesHome renders whatever is
// registered.
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
