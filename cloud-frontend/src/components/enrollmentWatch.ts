import { useEffect, useRef, useState } from 'react'

// Shared "did my frame show up yet?" watcher for the two enrollment flows
// that end with a device phoning home on its own schedule: the ESP32 browser
// flasher (board reboots, joins WiFi, enrolls with its claim token) and the
// SD image builder (card gets flashed, Pi boots, enrolls with the image's
// multi-use code). Both used to end on a static "Done." that left the user
// hitting refresh; polling the frames list turns that into a handoff to the
// newly enrolled frame.
//
// Polling, not the fleet websocket: enrollment is an HTTP call into auth-web
// — the hub only learns about a frame once it connects its WebSocket, so a
// pending frame produces no browser event at all.

export interface FrameListEntry {
  created_at?: string
  id: string
  name?: string
  status?: string
}

export async function fetchFrameList(): Promise<FrameListEntry[] | undefined> {
  try {
    const response = await fetch('/api/frames')
    if (!response.ok) {
      return undefined
    }
    const data = (await response.json()) as { frames?: FrameListEntry[] }
    return Array.isArray(data.frames) ? data.frames : undefined
  } catch {
    return undefined
  }
}

/** The newest frame that is not in the baseline set. */
export function findEnrolledFrame(
  frames: FrameListEntry[],
  knownFrameIds: ReadonlySet<string>
): FrameListEntry | undefined {
  const fresh = frames.filter((frame) => frame.id && !knownFrameIds.has(frame.id))
  if (fresh.length === 0) {
    return undefined
  }
  // Prefer pending (the status enrollment creates); newest first when the
  // account somehow gained several frames mid-flow.
  const byRecency = [...fresh].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  return byRecency.find((frame) => frame.status === 'pending') ?? byRecency[0]
}

const pollIntervalMs = 5000
// A frame may genuinely never enroll (wrong WiFi, no route to the cloud).
// Past this the UI must stop implying progress and offer troubleshooting —
// while still watching: the claim code stays valid, so the frame appears
// whenever it finally reaches the cloud.
const hintAfterMs = 2 * 60 * 1000

export interface EnrollmentWatchState {
  // `| undefined` explicitly: auth-web type-checks this file with
  // exactOptionalPropertyTypes, and the hook returns the useState value
  // (FrameListEntry | undefined) as this property.
  enrolledFrame?: FrameListEntry | undefined
  /** Waited long enough (~2 min) that the UI should show a troubleshooting hint. */
  hintDue: boolean
}

/**
 * Poll the account's frames list while `active`, reporting the first frame
 * that appears beyond the baseline. `knownFrameIds` is the caller's snapshot
 * of the fleet from before its claim token existed (the flasher takes one
 * pre-mint); pass null to let the first successful poll become the baseline
 * (the SD builder — nothing can boot the image before it is saved). Polling
 * lives exactly as long as the component and the `active` flag, so closing
 * the drawer stops it.
 */
export function useEnrollmentWatch({
  active,
  knownFrameIds = null,
}: {
  active: boolean
  knownFrameIds?: ReadonlySet<string> | null
}): EnrollmentWatchState {
  const [enrolledFrame, setEnrolledFrame] = useState<FrameListEntry | undefined>()
  const [hintDue, setHintDue] = useState(false)
  // The baseline may be established mid-watch (first successful poll); a ref
  // keeps it out of the effect's dependency list.
  const baselineRef = useRef<ReadonlySet<string> | null>(null)

  useEffect(() => {
    if (!active) {
      return
    }
    let cancelled = false
    let found = false
    setEnrolledFrame(undefined)
    setHintDue(false)
    baselineRef.current = knownFrameIds
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    const hintTimer = setTimeout(() => {
      if (!cancelled && !found) {
        setHintDue(true)
      }
    }, hintAfterMs)
    const poll = async (): Promise<void> => {
      const frames = await fetchFrameList()
      if (cancelled) {
        return
      }
      if (frames && baselineRef.current === null) {
        baselineRef.current = new Set(frames.map((frame) => frame.id))
      } else if (frames && baselineRef.current) {
        const fresh = findEnrolledFrame(frames, baselineRef.current)
        if (fresh) {
          found = true
          setEnrolledFrame(fresh)
          setHintDue(false)
          clearTimeout(hintTimer)
          return
        }
      }
      pollTimer = setTimeout(() => void poll(), pollIntervalMs)
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(pollTimer)
      clearTimeout(hintTimer)
    }
    // knownFrameIds is a snapshot taken before `active` flips on; re-running
    // on its identity would restart the watch for an equivalent set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  return { enrolledFrame, hintDue }
}
