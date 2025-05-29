import { actions, afterMount, connect, kea, listeners, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'
import { FrameScene, FrameType } from '../types'
import { socketLogic } from '../scenes/socketLogic'
import type { framesModelType } from './framesModelType'
import { router } from 'kea-router'
import { sanitizeScene } from '../scenes/frame/frameLogic'
import { apiFetch } from '../utils/apiFetch'
import { entityImagesModel } from './entityImagesModel'
import { urls } from '../urls'

export interface FrameImageInfo {
  url: string
  expiresAt: number
}

export const framesModel = kea<framesModelType>([
  connect({ logic: [socketLogic, entityImagesModel] }),
  path(['src', 'models', 'framesModel']),
  actions({
    addFrame: (frame: FrameType) => ({ frame }),
    loadFrame: (id: number) => ({ id }),
    deployFrame: (id: number, fastDeploy?: boolean) => ({ id, fastDeploy: fastDeploy || false }),
    stopFrame: (id: number) => ({ id }),
    restartFrame: (id: number) => ({ id }),
    rebootFrame: (id: number) => ({ id }),
    renderFrame: (id: number) => ({ id }),
    deleteFrame: (id: number) => ({ id }),
    deployAgent: (id: number) => ({ id }),
    restartAgent: (id: number) => ({ id }),
  }),
  loaders(({ values }) => ({
    frames: [
      {} as Record<number, FrameType>,
      {
        loadFrame: async ({ id }) => {
          try {
            const response = await apiFetch(`/api/frames/${id}`)
            if (!response.ok) {
              throw new Error('Failed to fetch frame')
            }
            const data = await response.json()
            const frame = data.frame as FrameType
            return {
              ...values.frames,
              [frame.id]: {
                ...frame,
                scenes: frame.scenes?.map((scene) => sanitizeScene(scene as FrameScene, frame)),
              },
            }
          } catch (error) {
            console.error(error)
            return values.frames
          }
        },
        loadFrames: async () => {
          try {
            const response = await apiFetch('/api/frames')
            if (!response.ok) {
              throw new Error('Failed to fetch frames')
            }
            const data = await response.json()
            const framesDict = Object.fromEntries(
              (data.frames as FrameType[]).map((frame) => [
                frame.id,
                {
                  ...frame,
                  scenes: frame.scenes?.map((scene) => sanitizeScene(scene as FrameScene, frame)),
                },
              ])
            )
            return framesDict
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
      {} as Record<number, FrameType>,
      {
        [socketLogic.actionTypes.newFrame]: (state, { frame }) => ({ ...state, [frame.id]: frame }),
        [socketLogic.actionTypes.updateFrame]: (state, { frame }) => ({
          ...state,
          [frame.id]: { ...(state[frame.id] ?? {}), ...frame },
        }),
        [socketLogic.actionTypes.deleteFrame]: (state, { id }) => {
          const newState = { ...state }
          delete newState[id]
          return newState
        },
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
  }),
  afterMount(({ actions }) => {
    actions.loadFrames()
  }),
  listeners(({ actions, values }) => ({
    renderFrame: async ({ id }) => {
      await apiFetch(`/api/frames/${id}/event/render`, { method: 'POST' })
    },
    deployFrame: async ({ id, fastDeploy }) => {
      if (fastDeploy) {
        await apiFetch(`/api/frames/${id}/fast_deploy`, { method: 'POST' })
      } else {
        await apiFetch(`/api/frames/${id}/deploy`, { method: 'POST' })
      }
    },
    stopFrame: async ({ id }) => {
      await apiFetch(`/api/frames/${id}/stop`, { method: 'POST' })
    },
    restartFrame: async ({ id }) => {
      await apiFetch(`/api/frames/${id}/restart`, { method: 'POST' })
    },
    rebootFrame: async ({ id }) => {
      await apiFetch(`/api/frames/${id}/reboot`, { method: 'POST' })
    },
    deployAgent: async ({ id }) => {
      await apiFetch(`/api/frames/${id}/deploy_agent`, { method: 'POST' })
    },
    restartAgent: async ({ id }) => {
      await apiFetch(`/api/frames/${id}/restart_agent`, { method: 'POST' })
    },
    deleteFrame: async ({ id }) => {
      await apiFetch(`/api/frames/${id}`, { method: 'DELETE' })
      if (router.values.location.pathname.includes('/frames/' + id)) {
        router.actions.push(urls.frames())
      }
    },
    [socketLogic.actionTypes.newLog]: ({ log }) => {
      if (log.type === 'webhook') {
        const parsed = JSON.parse(log.line)
        if (parsed.event == 'render:dither' || parsed.event == 'render:done' || parsed.event == 'server:start') {
          entityImagesModel.actions.updateEntityImage(`frames/${log.frame_id}`, 'image')
        }
      }
    },
  })),
])
