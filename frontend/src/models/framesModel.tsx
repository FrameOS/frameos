import { actions, afterMount, connect, kea, listeners, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'
import { FrameScene, FrameType } from '../types'
import { socketLogic } from '../scenes/socketLogic'
import type { framesModelType } from './framesModelType'
import { router } from 'kea-router'
import { sanitizeScene } from '../scenes/frame/frameLogic'
import { apiFetch } from '../utils/apiFetch'

export interface FrameImageInfo {
  url: string
  expiresAt: number
}

export const framesModel = kea<framesModelType>([
  connect({ logic: [socketLogic] }),
  path(['src', 'models', 'framesModel']),
  actions({
    addFrame: (frame: FrameType) => ({ frame }),
    loadFrame: (id: number) => ({ id }),
    redeployFrame: (id: number) => ({ id }),
    restartFrame: (id: number) => ({ id }),
    renderFrame: (id: number) => ({ id }),
    updateFrameImage: (id: number, force = true) => ({ id, force }),
    deleteFrame: (id: number) => ({ id }),
    setFrameImageInfo: (id: number, imageInfo: FrameImageInfo) => ({ id, imageInfo }),
    updateFrameImageTimestamp: (id: number) => ({ id }),
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
        [socketLogic.actionTypes.updateFrame]: (state, { frame }) => ({ ...state, [frame.id]: frame }),
        [socketLogic.actionTypes.deleteFrame]: (state, { id }) => {
          const newState = { ...state }
          delete newState[id]
          return newState
        },
      },
    ],
    frameImageInfos: [
      {} as Record<number, FrameImageInfo>,
      {
        setFrameImageInfo: (state, { id, imageInfo }) => ({ ...state, [id]: imageInfo }),
      },
    ],
    frameImageTimestamps: [
      {} as Record<number, number>,
      {
        updateFrameImageTimestamp: (state, { id }) => {
          const nowSeconds = Math.floor(Date.now() / 1000)
          // Only update if it's different, to ensure a re-render
          return state[id] === nowSeconds ? state : { ...state, [id]: nowSeconds }
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
    getFrameImage: [
      (s) => [s.frameImageInfos, s.frameImageTimestamps],
      (frameImageInfos, frameImageTimestamps) => {
        return (id: number) => {
          const info = frameImageInfos[id]
          const now = Math.floor(Date.now() / 1000)
          if (!info || !info.expiresAt || !info.url || now >= info.expiresAt) {
            return null
          }
          const timestamp = frameImageTimestamps[id] ?? -1
          return `${info.url}${info.url.includes('?') ? '&' : '?'}t=${timestamp}`
        }
      },
    ],
  }),
  afterMount(({ actions }) => {
    actions.loadFrames()
  }),
  listeners(({ actions, values }) => ({
    renderFrame: async ({ id }) => {
      await apiFetch(`/api/frames/${id}/event/render`, { method: 'POST' })
    },
    redeployFrame: async ({ id }) => {
      await apiFetch(`/api/frames/${id}/redeploy`, { method: 'POST' })
    },
    restartFrame: async ({ id }) => {
      await apiFetch(`/api/frames/${id}/restart`, { method: 'POST' })
    },
    deleteFrame: async ({ id }) => {
      await apiFetch(`/api/frames/${id}`, { method: 'DELETE' })
      if (router.values.location.pathname == '/frames/' + id) {
        router.actions.push('/')
      }
    },
    updateFrameImage: async ({ id, force }) => {
      // Check if we have a valid URL
      const imageUrl = values.getFrameImage(id)
      if (imageUrl) {
        // The URL is still valid, no need to refetch new signed URL
        // Just update timestamp to refresh (force reload)
        if (force) {
          actions.updateFrameImageTimestamp(id)
        }
        return
      }

      // Need a new signed URL
      const resp = await apiFetch(`/api/frames/${id}/image_link`)
      if (resp.ok) {
        const data = await resp.json()
        const expiresAt = Math.floor(Date.now() / 1000) + data.expires_in
        const imageInfo: FrameImageInfo = { url: data.url, expiresAt }
        actions.setFrameImageInfo(id, imageInfo)
        // Update timestamp to ensure a new request even if the URL is same
        if (force) {
          actions.updateFrameImageTimestamp(id)
        }
      } else {
        console.error('Failed to get image link for frame', id)
      }
    },
    [socketLogic.actionTypes.newLog]: ({ log }) => {
      if (log.type === 'webhook') {
        const parsed = JSON.parse(log.line)
        if (parsed.event == 'render:dither' || parsed.event == 'render:done' || parsed.event == 'server:start') {
          actions.updateFrameImage(log.frame_id)
        }
      }
    },
  })),
])
