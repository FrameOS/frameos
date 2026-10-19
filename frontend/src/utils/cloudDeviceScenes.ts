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
  /** Compiled (Nim) scenes the frame sent: an import can convert them to interpreted ones. */
  compiled_scenes?: { id: string; name: string }[]
  /** Compiled scenes the frame could only name: compiled into its program, their source is elsewhere. */
  compiled_unsent?: { id: string; name: string }[]
  /** Every compiled scene the frame holds, named or only counted (older firmware only counts). */
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
  /** A compiled scene on the frame, converted to an interpreted one. */
  converted?: boolean
  not_assigned_reason?: string
  /** Service-key groups the scene declares. An import grants NONE of them — what a scene declares is the device's say. */
  needs_settings_groups?: string[]
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

/**
 * Interpreted scenes still waiting for an import. A report an import already
 * went through stays `ready` only for a partial import (whose rest this
 * finishes) or for compiled scenes nobody has converted yet (which this is
 * not about).
 */
export function deviceScenesPlainImportable(deviceScenes: CloudDeviceScenes | null | undefined): boolean {
  return (
    !!deviceScenes &&
    deviceScenes.status === 'ready' &&
    deviceScenes.scene_count > 0 &&
    deviceScenes.result?.status !== 'imported'
  )
}

/** Compiled scenes the cloud can convert and import ("Convert and import"). */
export function deviceScenesConvertible(deviceScenes: CloudDeviceScenes | null | undefined): boolean {
  return !!deviceScenes && deviceScenes.status === 'ready' && (deviceScenes.compiled_scenes?.length ?? 0) > 0
}

/** Whether the workspace should offer the import for this report. */
export function deviceScenesImportable(deviceScenes: CloudDeviceScenes | null | undefined): boolean {
  return deviceScenesPlainImportable(deviceScenes) || deviceScenesConvertible(deviceScenes)
}

/**
 * Whether the banner has something to say: an import to offer, or compiled
 * scenes the frame runs that no import can bring over (so the owner learns
 * why the cloud lists less than the frame shows).
 */
export function deviceScenesWorthShowing(deviceScenes: CloudDeviceScenes | null | undefined): boolean {
  return (
    deviceScenesImportable(deviceScenes) ||
    (!!deviceScenes && deviceScenes.status === 'ready' && (deviceScenes.compiled_unsent?.length ?? 0) > 0)
  )
}

function quoted(names: string[], limit = 3): string {
  const shown = names.slice(0, limit).map((name) => `“${name}”`)
  const rest = names.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(shown.length === 2 ? ' and ' : ', ')
}

function compiledCount(count: number): string {
  return count === 1 ? 'a compiled scene' : `${count} compiled scenes`
}

/** "This frame is running 3 scenes of its own: “Clock”, “Photos” and 1 more." */
export function deviceScenesOffer(deviceScenes: CloudDeviceScenes): string {
  const compiled = deviceScenes.compiled_scenes ?? []
  const unsent = deviceScenes.compiled_unsent ?? []
  if (deviceScenesPlainImportable(deviceScenes) || (compiled.length === 0 && unsent.length === 0)) {
    const count = deviceScenes.scene_count
    const names = deviceScenes.scenes.map((scene) => scene.name)
    const listed = names.length > 0 ? `: ${quoted(names)}` : ''
    return `This frame is running ${count === 1 ? 'a scene' : `${count} scenes`} of its own${listed}.`
  }
  if (compiled.length > 0) {
    const names = quoted(compiled.map((scene) => scene.name))
    // After an import that left them: the interpreted ones are in already.
    return deviceScenes.result
      ? `The compiled scenes from this frame are not imported yet: ${names}.`
      : `This frame is running ${compiledCount(compiled.length)} of its own: ${names}.`
  }
  return `This frame is running ${compiledCount(unsent.length)} of its own: ${quoted(
    unsent.map((scene) => scene.name)
  )}.`
}

/**
 * What the banner says about the frame's compiled (Nim) scenes, after the
 * offer: which ones "Convert and import" can bring over, and which ones stay
 * on the frame because their source is not there.
 */
export function deviceScenesCompiledNotes(deviceScenes: CloudDeviceScenes): string[] {
  const lines: string[] = []
  const compiled = deviceScenes.compiled_scenes ?? []
  if (compiled.length > 0) {
    const them = compiled.length === 1 ? 'it' : 'them'
    lines.push(
      deviceScenesPlainImportable(deviceScenes)
        ? `It also runs ${compiledCount(compiled.length)} (${quoted(
            compiled.map((scene) => scene.name)
          )}), written in Nim, which the cloud does not run. Convert and import turns ${them} into interpreted scenes on the way in.`
        : `Compiled scenes are written in Nim, which the cloud does not run. Convert and import turns ${them} into interpreted scenes on the way in; the copies on the frame are left alone.`
    )
  }
  const unsent = deviceScenes.compiled_unsent ?? []
  if (unsent.length > 0) {
    const one = unsent.length === 1
    lines.push(
      `${quoted(unsent.map((scene) => scene.name))} ${one ? 'is' : 'are'} compiled into the frame's program, and ${
        one ? 'its' : 'their'
      } source is not on the frame. Export ${
        one ? 'it' : 'them'
      } from the FrameOS backend that deployed the frame and convert ${
        one ? 'it' : 'them'
      } with the Nim converter (scenes.frameos.net/nim-converter).`
    )
  }
  return lines
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
    case 'conversion_incomplete':
      return 'the converter could not port all of its Nim, so it stays on the frame'
    case 'conversion_needs_model':
      return "converting it needs the AI model, and the free allowance is used up for now. Try again later, or add your own OpenAI key in the account's settings"
    case 'conversion_next_batch':
      return 'a few compiled scenes are converted at a time. Import the rest to continue'
    case 'conversion_failed':
      return 'the converter could not reach the AI model. Try again in a minute'
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
    const converted = result.imported.filter((scene) => scene.converted).length
    if (converted > 0) {
      parts.push(`${converted} of them converted from ${converted === 1 ? 'a compiled scene' : 'compiled scenes'}`)
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
  const needsKeys = [...result.imported, ...result.reused].filter(
    (scene) => scene.assigned && (scene.needs_settings_groups?.length ?? 0) > 0
  )
  if (needsKeys.length > 0) {
    const groups = [...new Set(needsKeys.flatMap((scene) => scene.needs_settings_groups ?? []))].sort()
    lines.push(
      `${quoted(needsKeys.map((scene) => scene.name))} ${needsKeys.length === 1 ? 'uses' : 'use'} your ${groups.join(
        ', '
      )} ${
        groups.length === 1 ? 'key' : 'keys'
      }. Importing shares no keys with a frame: allow them per scene in the frame's settings, under Service settings.`
    )
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
