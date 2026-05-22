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

function sanitizeFrameForStore(frame: FrameType): FrameType {
  const lastSuccessfulDeploy = frame.last_successful_deploy
  return {
    ...frame,
    scenes: frame.scenes?.map((scene) => sanitizeScene(scene as FrameScene, frame)) ?? [],
    last_successful_deploy:
      lastSuccessfulDeploy && Array.isArray(lastSuccessfulDeploy.scenes)
        ? {
            ...lastSuccessfulDeploy,
            scenes: lastSuccessfulDeploy.scenes.map((scene: FrameScene) =>
              sanitizeScene(scene as FrameScene, lastSuccessfulDeploy as Partial<FrameType>)
            ),
          }
        : lastSuccessfulDeploy,
  }
}

function sortFrames(frames: FrameType[]): FrameType[] {
  return frames.sort(
    (a, b) => a.frame_host.localeCompare(b.frame_host) || (a.ssh_user || '').localeCompare(b.ssh_user || '')
  )
}

export const framesModel = kea<framesModelType>([
  connect(() => ({ logic: [socketLogic, entityImagesModel] })),
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
    renameFrame: (id: number, name: string) => ({ id, name }),
    deployAgent: (id: number) => ({ id }),
    restartAgent: (id: number) => ({ id }),
    setDeployWithAgent: (id: number, deployWithAgent: boolean) => ({ id, deployWithAgent }),
    setFrameArchived: (id: number, archived: boolean) => ({ id, archived }),
    toggleArchivedFramesExpanded: true,
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
              [frame.id]: sanitizeFrameForStore(frame),
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
              (data.frames as FrameType[]).map((frame) => [frame.id, sanitizeFrameForStore(frame)])
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
        addFrame: (state, { frame }) => ({
          ...state,
          [frame.id]: sanitizeFrameForStore(frame),
        }),
        setDeployWithAgent: (state, { id, deployWithAgent }) => {
          const frame = state[id]
          if (!frame) return state
          return {
            ...state,
            [id]: {
              ...frame,
              agent: { ...frame.agent, deployWithAgent },
            },
          }
        },
        setFrameArchived: (state, { id, archived }) => {
          const frame = state[id]
          if (!frame) return state
          return {
            ...state,
            [id]: {
              ...frame,
              archived,
            },
          }
        },
        renameFrame: (state, { id, name }) => {
          const frame = state[id]
          if (!frame) return state
          return {
            ...state,
            [id]: {
              ...frame,
              name,
            },
          }
        },
        [socketLogic.actionTypes.newFrame]: (state, { frame }) => ({
          ...state,
          [frame.id]: sanitizeFrameForStore(frame),
        }),
        [socketLogic.actionTypes.updateFrame]: (state, { frame }) => ({
          ...state,
          [frame.id]: sanitizeFrameForStore({ ...(state[frame.id] ?? {}), ...frame }),
        }),
        [socketLogic.actionTypes.deleteFrame]: (state, { id }) => {
          const newState = { ...state }
          delete newState[id]
          return newState
        },
      },
    ],
    archivedFramesExpanded: [
      false,
      { persist: true, storageKey: 'framesModel.archivedFramesExpanded' },
      {
        toggleArchivedFramesExpanded: (state) => !state,
      },
    ],
  })),
  selectors({
    framesList: [(s) => [s.frames], (frames) => sortFrames(Object.values(frames)) as FrameType[]],
    activeFramesList: [
      (s) => [s.frames],
      (frames) => sortFrames(Object.values(frames).filter((frame) => !frame.archived)) as FrameType[],
    ],
    archivedFramesList: [
      (s) => [s.frames],
      (frames) => sortFrames(Object.values(frames).filter((frame) => frame.archived)) as FrameType[],
    ],
    framesLoaded: [(s) => [s.frames], (frames) => Object.keys(frames).length > 0],
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
    setDeployWithAgent: async ({ id, deployWithAgent }) => {
      const frame = values.frames[id]
      if (!frame) return
      await apiFetch(`/api/frames/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: { ...frame?.agent, deployWithAgent } }),
      })
    },
    setFrameArchived: async ({ id, archived }) => {
      try {
        const response = await apiFetch(`/api/frames/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived }),
        })
        if (!response.ok) {
          throw new Error('Failed to update frame archive status')
        }
      } catch (error) {
        console.error(error)
        actions.loadFrame(id)
      }
    },
    deleteFrame: async ({ id }) => {
      await apiFetch(`/api/frames/${id}`, { method: 'DELETE' })
      if (router.values.location.pathname.includes('/frames/' + id)) {
        router.actions.push(urls.frames())
      }
    },
    renameFrame: async ({ id, name }) => {
      try {
        const response = await apiFetch(`/api/frames/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        if (!response.ok) {
          throw new Error('Failed to rename frame')
        }
      } catch (error) {
        console.error(error)
        actions.loadFrame(id)
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
