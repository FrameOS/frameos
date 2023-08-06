import { actions, afterMount, kea, path, reducers } from 'kea'

import type { framesLogicType } from './framesLogicType'
import { forms } from 'kea-forms'
import { loaders } from 'kea-loaders'
import { FrameType } from '~/types'

export const framesLogic = kea<framesLogicType>([
  path(['src', 'frames', 'framesLogic']),
  actions({
    addFrame: (frame: FrameType) => ({ frame }),
  }),
  forms(({ actions }) => ({
    newFrame: {
      defaults: {} as FrameType,
      errors: (frame: Partial<FrameType>) => ({
        ip: !frame.ip ? 'Please enter IP' : null,
      }),
      submit: async (frame) => {
        console.log({ frame })
        try {
          const formData = new FormData()
          Object.keys(frame).forEach((key) => {
            formData.append(key, (frame as any)[key])
          })

          const response = await fetch('/api/frames/new', {
            method: 'POST',
            body: formData,
          })

          if (!response.ok) {
            throw new Error('Failed to submit frame')
          }

          actions.resetNewFrame()
        } catch (error) {
          console.error(error)
        }
      },
    },
  })),
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
  reducers({
    frames: {
      submitNewFrameSuccess: (state, payload) => [...state, payload.newFrame],
    },
  }),
  afterMount(({ actions }) => {
    actions.loadFrames()
  }),
])
