import { actions, afterMount, connect, kea, listeners, path, reducers, selectors } from 'kea'

import { loaders } from 'kea-loaders'
import { FrameType } from '../types'
import { socketLogic } from '../scenes/socketLogic'

import type { framesModelType } from './framesModelType'
import { router } from 'kea-router'

export const framesModel = kea<framesModelType>([
  connect({ logic: [socketLogic] }),
  path(['src', 'models', 'framesModel']),
  actions({
    addFrame: (frame: FrameType) => ({ frame }),
    loadFrame: (id: number) => ({ id }),
    redeployFrame: (id: number) => ({ id }),
    restartFrame: (id: number) => ({ id }),
    renderFrame: (id: number) => ({ id }),
    updateFrameImage: (id: number) => ({ id }),
    deleteFrame: (id: number) => ({ id }),
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
        [socketLogic.actionTypes.deleteFrame]: (state, { id }) => {
          const newState = { ...state }
          delete newState[id]
          return newState
        },
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
    framesList: [
      (s) => [s.frames],
      (frames) =>
        Object.values(frames).sort(
          (a, b) => a.frame_host.localeCompare(b.frame_host) || (a.ssh_user || '').localeCompare(b.ssh_user || '')
        ) as FrameType[],
    ],
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
    renderFrame: async ({ id }) => {
      await fetch(`/api/frames/${id}/event/render`, { method: 'POST' })
    },
    redeployFrame: async ({ id }) => {
      await fetch(`/api/frames/${id}/redeploy`, { method: 'POST' })
    },
    restartFrame: async ({ id }) => {
      await fetch(`/api/frames/${id}/restart`, { method: 'POST' })
    },
    deleteFrame: async ({ id }) => {
      await fetch(`/api/frames/${id}`, { method: 'DELETE' })
      if (router.values.location.pathname == '/frames/' + id) {
        router.actions.push('/')
      }
    },
    [socketLogic.actionTypes.newLog]: ({ log }) => {
      if (log.type === 'webhook') {
        const parsed = JSON.parse(log.line)
        if (parsed.event == 'renderScene:done' || parsed.event == 'http:start') {
          actions.updateFrameImage(log.frame_id)
        }
      }
    },
  })),
])
