import { actions, afterMount, connect, kea, listeners, path, reducers, selectors } from 'kea'

import { loaders } from 'kea-loaders'
import { FrameType } from '../types'
import { socketLogic } from '../scenes/socketLogic'

import type { framesModelType } from './framesModelType'

export const framesModel = kea<framesModelType>([
  connect({ logic: [socketLogic] }),
  path(['src', 'models', 'framesModel']),
  actions({
    addFrame: (frame: FrameType) => ({ frame }),
    loadFrame: (id: number) => ({ id }),
    redeployFrame: (id: number) => ({ id }),
    restartFrame: (id: number) => ({ id }),
    refreshFrame: (id: number) => ({ id }),
    updateFrameImage: (id: number) => ({ id }),
  }),
  loaders(({ values }) => ({
    frames: [
      {} as Record<number, FrameType>,
      {
        loadFrame: async ({ id }) => {
          try {
            const response = await fetch(`/api/frames/${id}`)
            if (!response.ok) {
              throw new Error('Failed to fetch logs')
            }
            const data = await response.json()
            return { ...values.frames, frame: data.frame as FrameType }
          } catch (error) {
            console.error(error)
            return values.frames
          }
        },
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
            return values.frames
          }
        },
      },
    ],
  })),
  reducers(() => ({
    frames: [
      {} as Record<string, FrameType>,
      {
        [socketLogic.actionTypes.newFrame]: (state, { frame }) => ({ ...state, [frame.id]: frame }),
        [socketLogic.actionTypes.updateFrame]: (state, { frame }) => ({ ...state, [frame.id]: frame }),
      },
    ],
    frameImageTimestamps: [
      {} as Record<string, number>,
      {
        updateFrameImage: (state, { id }) => ({ ...state, [id]: Date.now().valueOf() }),
      },
    ],
  })),
  selectors({
    framesList: [(s) => [s.frames], (frames) => Object.values(frames).sort((a, b) => a.id - b.id) as FrameType[]],
    getFrameImage: [
      (s) => [s.frameImageTimestamps],
      (frameImageTimestamps) => {
        return (id) => {
          return `/api/frames/${id}/image?t=${frameImageTimestamps[id] ?? -1}`
        }
      },
    ],
  }),
  afterMount(({ actions }) => {
    actions.loadFrames()
  }),
  listeners(({ props, actions }) => ({
    redeployFrame: async ({ id }) => {
      await fetch(`/api/frames/${id}/initialize`, { method: 'POST' })
    },
    refreshFrame: async ({ id }) => {
      await fetch(`/api/frames/${id}/refresh`, { method: 'POST' })
    },
    restartFrame: async ({ id }) => {
      await fetch(`/api/frames/${id}/restart`, { method: 'POST' })
    },
    [socketLogic.actionTypes.newLog]: ({ log }) => {
      if (log.type === 'webhook') {
        const parsed = JSON.parse(log.line)
        if (parsed.event == 'refresh_begin' || parsed.event == 'refresh_end') {
          actions.updateFrameImage(log.frame_id)
        }
      }
    },
  })),
])
