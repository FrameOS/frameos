import type { FrameType } from '../types'
import { apiFetch } from './apiFetch'
import { cloudFrameSettingKeys, cloudFrameSettingsPayload, type CloudFrameSettingKey } from './cloudFrameSettings'
import type { FrameId } from './frameId'

// FrameOS Cloud speaks a much narrower dialect than the FrameOS backend: an
// enqueued command with one of four verbs, or a declarative settings push.
// There is no POST /api/frames/{id}, no /event/*, no deploy, no shell. The
// shared SPA used to call the backend paths in cloud mode too, so Save and
// Render always errored — everything cloud-bound goes through here instead.
//
// Wire contract: cloud/apps/auth-web/app/api/frames/[frameId]/{command,settings}
// and cloud/docs/cloud-frames.md.

/** allowedFrameCommandTypes in cloud/apps/auth-web/src/lib/frames.ts. */
export type CloudFrameCommand = 'reboot' | 'render' | 'restart_runtime' | 'set_current_scene'

// The settings allowlist and its payload builder live in the import-free
// cloudFrameSettings module (it is unit-tested from the cloud app's node
// suite); re-exported here so callers keep one import.
export { cloudFrameSettingKeys, cloudFrameSettingsPayload }
export type { CloudFrameSettingKey }

// Compile-time guard: every allowlisted key must be a real FrameType field, so
// a rename in the form cannot leave a dead key on the wire.
const cloudFrameSettingKeysAreFrameFields: readonly (keyof FrameType)[] = cloudFrameSettingKeys
void cloudFrameSettingKeysAreFrameFields

async function assertOk(response: Response, fallback: string): Promise<void> {
  if (response.ok) {
    return
  }
  const detail = (await response.json().catch(() => ({}))) as { error?: string }
  throw new Error(detail.error ? `${fallback} (${detail.error})` : fallback)
}

export async function sendCloudFrameCommand(
  frameId: FrameId,
  type: CloudFrameCommand,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const response = await apiFetch(`/api/frames/${frameId}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...payload }),
  })
  await assertOk(response, `Failed to send "${type}" to the frame`)
}

/**
 * Push the declarative settings subset. Returns false when nothing in the
 * form maps onto a cloud setting — the caller should then not report success
 * for a request it never made.
 */
export async function pushCloudFrameSettings(frameId: FrameId, frame: Partial<FrameType>): Promise<boolean> {
  const settings = cloudFrameSettingsPayload(frame)
  if (Object.keys(settings).length === 0) {
    return false
  }
  const response = await apiFetch(`/api/frames/${frameId}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
  await assertOk(response, 'Failed to save the frame settings')
  return true
}
