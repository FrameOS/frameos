/**
 * A frame's identity as the control plane hands it to us. The FrameOS backend
 * numbers its frames; FrameOS Cloud keys them by uuid (cloud/packages/db
 * schema `frames.id` is a `uuid`, served verbatim by `frameSummary`). The SPA
 * is shared by both adapters, so an id is opaque here: never parse it, never
 * do arithmetic on it, and compare with `frameIdsEqual` so a route's string
 * `"7"` still matches the backend's numeric `7`.
 *
 * It lives in this module rather than in types.tsx so that this file has no
 * imports at all: the cloud app's node test suite exercises it directly, and
 * types.tsx pulls in reactflow and the whole device catalogue.
 */
export type FrameId = number | string

// Frame ids are opaque. The FrameOS backend numbers its frames, FrameOS Cloud
// keys them by uuid, and the same SPA drives both — so a route segment can
// never be `parseInt`ed: on the cloud that turns "b3f1…" into NaN (or, worse,
// "7b3f…" into 7) and every `frame.id === routeFrameId` comparison silently
// misses, landing the user on somebody else's frame. Route segments always
// arrive as strings, ids in memory may be numbers, so compare stringified.

/** Route/select-element values arrive as strings; ids in memory may be numbers. */
export function frameIdsEqual(a: FrameId | null | undefined, b: FrameId | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return false
  }
  return String(a) === String(b)
}

/**
 * Turn a raw route segment into an id we can hand to logics and API paths.
 * Numeric segments become numbers so backend-mode keys (and the `frames`
 * record, which the backend fills with numeric ids) keep matching; anything
 * else — a uuid — stays a string.
 */
export function parseRouteFrameId(frameId?: string | null): FrameId | null {
  if (frameId === null || frameId === undefined) {
    return null
  }
  const trimmed = String(frameId).trim()
  if (!trimmed) {
    return null
  }
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10)
  }
  return trimmed
}

/** Look a frame up in a keyed record with either id flavour. */
export function frameById<T>(frames: Record<FrameId, T>, frameId: FrameId | null | undefined): T | undefined {
  if (frameId === null || frameId === undefined) {
    return undefined
  }
  return frames[frameId as keyof typeof frames] ?? frames[String(frameId) as keyof typeof frames]
}
