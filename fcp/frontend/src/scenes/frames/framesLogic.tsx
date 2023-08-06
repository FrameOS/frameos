import { actions, afterMount, kea, path, reducers, selectors } from 'kea'

import type { framesLogicType } from './framesLogicType'
import { forms } from 'kea-forms'
import { loaders } from 'kea-loaders'
import { FrameType } from '../../types'
import { socketLogic } from '../socketLogic'

export const framesLogic = kea<framesLogicType>([
  path(['src', 'frames', 'framesLogic']),
  actions({
    addFrame: (frame: FrameType) => ({ frame }),
  }),
  forms(({ actions }) => ({
    newFrame: {
      defaults: {} as FrameType,
      errors: (frame: Partial<FrameType>) => ({
        host: !frame.host ? 'Please enter a host' : null,
      }),
      submit: async (frame) => {
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
      {} as Record<number, FrameType>,
      {
        loadFrames: async () => {
          try {
            const response = await fetch('/api/frames')
            if (!response.ok) {
              throw new Error('Failed to fetch frames')
            }
            const data = await response.json()
            return Object.fromEntries((data.frames as FrameType[]).map((frame) => [frame.id, frame]))
          } catch (error) {
            console.error(error)
            return []
          }
        },
      },
    ],
  }),
  selectors({
    framesList: [(s) => [s.frames], (frames) => Object.values(frames).sort((a, b) => a.id - b.id) as FrameType[]],
  }),
  reducers({
    frames: {
      [socketLogic.actionTypes.newFrame]: (state, { frame }) => ({ ...state, [frame.id]: frame }),
      [socketLogic.actionTypes.updateFrame]: (state, { frame }) => ({ ...state, [frame.id]: frame }),
    },
  }),
  afterMount(({ actions }) => {
    actions.loadFrames()
  }),
])
