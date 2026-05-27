import { frameIsActive } from '../../decorators/frame'
import type { FrameType } from '../../types'

export interface FrameStatusGroup {
  key: 'active' | 'inactive' | 'archived'
  label: string
  frames: FrameType[]
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
    { key: 'active', label: 'Active', frames: active },
    { key: 'inactive', label: 'Inactive', frames: inactive },
    { key: 'archived', label: 'Archived', frames: archived },
  ]

  return groups.filter((group) => group.frames.length > 0)
}
