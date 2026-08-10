import { frameHost, frameIsActive } from '../../decorators/frame'
import type { FrameType } from '../../types'

export interface FrameStatusGroup {
  key: 'active' | 'inactive' | 'archived'
  label: string
  frames: FrameType[]
}

function frameSortName(frame: FrameType): string {
  // A freshly enrolled cloud frame can have neither a name nor a host —
  // undefined here crashed the home list's sort into a white screen.
  return String(frame.name ?? frameHost(frame) ?? frame.id ?? '').trim()
}

function sortFramesAlphabetically(frames: FrameType[]): FrameType[] {
  return [...frames].sort((first, second) => {
    const byName = frameSortName(first).localeCompare(frameSortName(second), undefined, {
      numeric: true,
      sensitivity: 'base',
    })
    // Ids are opaque (numbers on the backend, uuids on the cloud): compare as
    // strings so the tie-break is stable in both modes.
    return byName !== 0 ? byName : String(first.id).localeCompare(String(second.id))
  })
}

export function groupFramesByStatus(frames: FrameType[]): FrameStatusGroup[] {
  const active: FrameType[] = []
  const inactive: FrameType[] = []
  const archived: FrameType[] = []

  frames.forEach((frame) => {
    if (frame.archived) {
      archived.push(frame)
    } else if (frameIsActive(frame)) {
      active.push(frame)
    } else {
      inactive.push(frame)
    }
  })

  const groups: FrameStatusGroup[] = [
    { key: 'active', label: 'Active', frames: sortFramesAlphabetically(active) },
    { key: 'inactive', label: 'Inactive', frames: sortFramesAlphabetically(inactive) },
    { key: 'archived', label: 'Archived', frames: sortFramesAlphabetically(archived) },
  ]

  return groups.filter((group) => group.frames.length > 0)
}
