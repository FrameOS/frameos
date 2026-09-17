/**
 * How often the workspace re-fetches a frame's current image on the
 * on-device panel.
 *
 * The device encodes that image on request — a second at 1080p on a Pi,
 * several while the runner is busy — and one render produces two signals
 * (the WebSocket "render" ping and the render:done log line) for two tiles
 * (sidebar and dashboard). The animated status screen renders every second.
 * Left alone, that was a fetch storm and a preview that never stopped
 * pulsing "loading". This plans one refresh at a time: the first request
 * goes out now, anything that arrives within the window collapses into one
 * trailing refresh at the window's end.
 */
export const FRAME_IMAGE_REFRESH_MIN_INTERVAL_MS = 3000

export interface FrameImageRefreshPlan {
  /** Bump the image now. */
  refreshNow: boolean
  /** Bump the image this many milliseconds from now instead (0 = nothing to schedule). */
  delayMs: number
}

export function planFrameImageRefresh(
  lastRefreshAt: number | undefined,
  now: number,
  minIntervalMs: number = FRAME_IMAGE_REFRESH_MIN_INTERVAL_MS
): FrameImageRefreshPlan {
  if (lastRefreshAt === undefined || now - lastRefreshAt >= minIntervalMs) {
    return { refreshNow: true, delayMs: 0 }
  }
  return { refreshNow: false, delayMs: Math.max(1, lastRefreshAt + minIntervalMs - now) }
}

export interface FrameImageHeadUpdate {
  id: number
  active_scene_id?: string
  frame_sync_hint?: {
    has_changes: boolean
    checked_at: string
    current_revision: string | null
    deployed_revision: string | null
    frame_config_modified_at: string | null
    scenes_modified_at: string | null
    last_successful_deploy_at: string | null
  }
}

/**
 * What the HEAD of a frame's image says about the frame row: the sync hint,
 * and the scene that drew the image. The scene rides the same request, so a
 * frame whose last scene change is long out of the logs still gets its label
 * without a /states round-trip to the device. Null when it says nothing.
 */
export function frameUpdateFromImageHeaders(
  frameId: number,
  headers: { get(name: string): string | null },
  now: Date = new Date()
): FrameImageHeadUpdate | null {
  const syncChanged = headers.get('x-frameos-sync-changed')
  const hasSyncHint = syncChanged === '0' || syncChanged === '1'
  const activeSceneId = headers.get('x-scene-id')
  if (!hasSyncHint && !activeSceneId) {
    return null
  }
  return {
    id: frameId,
    ...(activeSceneId ? { active_scene_id: activeSceneId } : {}),
    ...(hasSyncHint
      ? {
          frame_sync_hint: {
            has_changes: syncChanged === '1',
            checked_at: headers.get('x-frameos-sync-checked-at') || now.toISOString(),
            current_revision: headers.get('x-frameos-sync-revision'),
            deployed_revision: headers.get('x-frameos-deployed-revision'),
            frame_config_modified_at: headers.get('x-frameos-frame-config-modified-at'),
            scenes_modified_at: headers.get('x-frameos-scenes-modified-at'),
            last_successful_deploy_at: headers.get('x-frameos-last-successful-deploy-at'),
          },
        }
      : {}),
  }
}
