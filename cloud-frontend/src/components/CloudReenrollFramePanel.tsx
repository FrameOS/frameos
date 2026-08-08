import type { ReactElement } from 'react'

import type { ReenrollFramePanelProps } from '../../../frontend/src/scenes/workspace/reenrollFramePanelRegistry'
import { cloudOrigin } from '../cloudConfig'
import { Esp32CloudFlasher } from './Esp32CloudFlasher'

// Re-enrollment for a board whose NVS is gone (factory reset, or a full 0x0
// flash): the same browser flasher the "Add frame" panel uses, in the mode
// that mints a claim token BOUND to an existing frame. Redeeming one re-keys
// that frame — new device key, rotated link token, same frames.id — so the
// account keeps one row for one board instead of the duplicate an ordinary
// enrollment would fork (docs/cloud-frames.md, "Re-enrollment").
//
// The shared workspace renders this through
// frontend/src/scenes/workspace/reenrollFramePanelRegistry.ts, the same
// inward-pointing handoff CloudAddFrameDrawer uses: frontend/ must not import
// cloud-frontend/, so the cloud bundle registers the panel at startup.
export function CloudReenrollFramePanel({ frameId, frameName }: ReenrollFramePanelProps): ReactElement {
  // Ids are opaque in the shared SPA (number on the backend, uuid here); the
  // cloud API only ever speaks uuids, so stringify and hand it over.
  return <Esp32CloudFlasher cloudOrigin={cloudOrigin()} reenrollFrame={{ id: String(frameId), name: frameName }} />
}
