// The scenes a frame was ALREADY running when it joined the cloud
// (docs/cloud-frames.md, `scenes_get`). The cloud models a frame's scenes as
// store-scene assignments, so a frame that ran standalone first would list
// none while it keeps rendering its own. The hub asks such a frame what it
// holds; the workspace offers to import the answer (the banner in
// FrameDashboardSurface), and the cloud mints private drafts, assigns them and
// pushes them back — after which it is an ordinary cloud frame.
//
// Import-free on purpose: the cloud app's node test suite exercises these
// helpers directly.

/** `device_scenes` of GET /api/frames/{frameId}/scenes — names only, never a scene body. */
export interface CloudDeviceScenes {
  /** ready: waiting for the owner · importing · imported · dismissed */
  status: string
  scene_count: number
  scenes: { id: string; name: string }[]
  /** Compiled scenes the frame counted and could not send. */
  skipped_compiled: number
  received_at?: string
  /** The last import's outcome, when there was one (a `partial` import leaves the report `ready`). */
  result?: CloudDeviceScenesImportResult | null
}

export interface CloudDeviceSceneOutcome {
  device_scene_id: string
  name: string
  scene_id: string
  version: number
  assigned: boolean
  not_assigned_reason?: string
}

/** POST /api/frames/{frameId}/device-scenes. */
export interface CloudDeviceScenesImportResult {
  status: 'imported' | 'partial'
  assigned: number
  imported: CloudDeviceSceneOutcome[]
  reused: CloudDeviceSceneOutcome[]
  skipped: { device_scene_id: string; name: string; reason: string }[]
  skipped_compiled: number
  command_id?: string | null
  connected?: boolean
}

/** Whether the workspace should offer the import for this report. */
export function deviceScenesImportable(deviceScenes: CloudDeviceScenes | null | undefined): boolean {
  return !!deviceScenes && deviceScenes.status === 'ready' && deviceScenes.scene_count > 0
}

function quoted(names: string[], limit = 3): string {
  const shown = names.slice(0, limit).map((name) => `“${name}”`)
  const rest = names.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(shown.length === 2 ? ' and ' : ', ')
}

/** "This frame is running 3 scenes of its own: “Clock”, “Photos” and 1 more." */
export function deviceScenesOffer(deviceScenes: CloudDeviceScenes): string {
  const count = deviceScenes.scene_count
  const names = deviceScenes.scenes.map((scene) => scene.name)
  const listed = names.length > 0 ? `: ${quoted(names)}` : ''
  return `This frame is running ${count === 1 ? 'a scene' : `${count} scenes`} of its own${listed}.`
}

/** Why a scene was left out, in the owner's words. Unknown codes are shown as they are. */
export function deviceSceneSkipReason(reason: string): string {
  switch (reason) {
    case 'scene_requires_compilation':
      return 'it is a legacy compiled scene — convert it with the Nim converter first'
    case 'daily_scene_limit_exceeded':
      return "today's limit for new scenes is reached — import the rest tomorrow"
    case 'scene_quota_exceeded':
      return 'your account is at its scene limit'
    case 'storage_quota_exceeded':
      return 'your account is out of private scene storage'
    case 'moderation_unavailable':
      return 'the content check is unavailable right now — try again in a minute'
    case 'content_rejected':
      return 'its name or description was refused by the content check'
    case 'scene_too_large':
      return 'it is too large for the scene store'
    case 'scene_not_allowed':
      return 'it runs shell commands, which a cloud frame never receives — it is saved as a draft only'
    case 'frame_full':
      return 'the frame already holds 20 scenes — it is saved as a draft only'
    default:
      return reason.replace(/_/g, ' ')
  }
}

/**
 * What an import did, as the lines the banner shows afterwards. The first
 * line is always the headline; the rest name what did not make it and why.
 */
export function deviceScenesImportSummary(result: CloudDeviceScenesImportResult): string[] {
  const lines: string[] = []
  const landed = result.imported.length + result.reused.length
  if (landed === 0) {
    lines.push('No scenes could be imported.')
  } else {
    const parts: string[] = []
    if (result.imported.length > 0) {
      parts.push(`${result.imported.length} imported as private drafts`)
    }
    if (result.reused.length > 0) {
      parts.push(`${result.reused.length} already in your scenes`)
    }
    const where =
      result.assigned === 0
        ? ''
        : result.connected === false
        ? ' The frame takes them over when it next connects.'
        : ' The frame is taking them over now.'
    lines.push(`${parts.join(', ')}.${where}`)
  }
  for (const scene of [...result.imported, ...result.reused]) {
    if (!scene.assigned && scene.not_assigned_reason) {
      lines.push(`“${scene.name}” is not on the frame: ${deviceSceneSkipReason(scene.not_assigned_reason)}.`)
    }
  }
  for (const scene of result.skipped) {
    lines.push(`“${scene.name}” was left out: ${deviceSceneSkipReason(scene.reason)}.`)
  }
  if (result.skipped_compiled > 0) {
    lines.push(
      `${
        result.skipped_compiled === 1 ? 'One compiled scene' : `${result.skipped_compiled} compiled scenes`
      } stayed on the frame: the cloud only runs interpreted scenes.`
    )
  }
  return lines
}
