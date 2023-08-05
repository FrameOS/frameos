import { afterMount, kea, path } from 'kea'

import type { framesLogicType } from './framesLogicType'
import { loaders } from 'kea-loaders'
import { FrameType } from '../types'

export const framesLogic = kea<framesLogicType>([
  path(['src', 'frames', 'framesLogic']),
  loaders({
    frames: [
      [] as FrameType[],
      {
        loadFrames: async () => {
          try {
            const response = await fetch('/api/frames')
            if (!response.ok) {
              throw new Error('Failed to fetch frames')
            }
            const data = await response.json()
            return data.frames as FrameType[]
          } catch (error) {
            console.error(error)
            return []
          }
        },
      },
    ],
  }),
  afterMount(({ actions }) => {
    actions.loadFrames()
  }),
])
