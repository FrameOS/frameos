// Sleep-aware command timing for deep-sleeping frames (docs/cloud-frames.md,
// "sleep"). Pure on purpose — the hub and the routes both import it, and the
// unit tests run it without a database.

// The firmware caps one sleep at 7 days; anything past that (plus an hour of
// clock skew) on a frame row is a broken forecast and is not waited for.
export const maxSleepWaitMs = (7 * 86_400 + 3_600) * 1000;

/**
 * How long a "fetch me something now" command (image_get, asset_get) should
 * stay valid for this frame. A frame that is asleep cannot see the command
 * until it wakes: a 2-minute TTL on a frame that sleeps 15 minutes expires
 * every time — the E1004 whose image never updated for days. So the TTL
 * reaches past the announced wake (`next_wake_at` from the device's `sleep`
 * message) by the base TTL, and is the base TTL alone for an awake frame or
 * one with no forecast.
 */
export function commandTtlForFrame(
  frame: { nextWakeAt: Date | null },
  baseTtlMs: number,
  now = Date.now(),
): number {
  const wakeAt = frame.nextWakeAt?.getTime();
  if (wakeAt === undefined || !Number.isFinite(wakeAt) || wakeAt <= now) {
    return baseTtlMs;
  }
  return Math.min(wakeAt - now, maxSleepWaitMs) + baseTtlMs;
}

/** Is the frame's own forecast saying it is asleep right now? */
export function frameIsAsleep(
  frame: { nextWakeAt: Date | null },
  now = Date.now(),
): boolean {
  const wakeAt = frame.nextWakeAt?.getTime();
  return wakeAt !== undefined && Number.isFinite(wakeAt) && wakeAt > now;
}

/**
 * The preview-watch grace for a frame that deep sleeps between renders: a
 * person who opened the frame's page while it slept is still "looking" when
 * it wakes and renders one sleep later, so the three-minute watch window
 * stretches by the length of the last announced sleep (bounded like the
 * TTL). Zero for frames that never announced a sleep.
 */
export function previewWatchGraceMs(lastSleepSeconds: number | undefined): number {
  if (lastSleepSeconds === undefined || !Number.isFinite(lastSleepSeconds) || lastSleepSeconds <= 0) {
    return 0;
  }
  return Math.min(Math.round(lastSleepSeconds) * 1000, maxSleepWaitMs);
}
