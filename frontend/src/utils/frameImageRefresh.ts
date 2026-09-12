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
