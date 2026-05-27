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
import { logUpdatesFrameActivity } from '../decorators/frame'
import { longRunningTasksModel } from './longRunningTasksModel'

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

function activeSceneIdFromLogLine(line: string): string | null {
  try {
    const payload = JSON.parse(line)
    if (
      ['render:sceneChange', 'event:setCurrentScene', 'event:uploadScenes'].includes(payload?.event) &&
      typeof payload.sceneId === 'string'
    ) {
      return payload.sceneId
    }
  } catch (error) {}
  return null
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
    deployAgent: (id: number, recompile?: boolean) => ({ id, recompile: recompile || false }),
    restartAgent: (id: number) => ({ id }),
    setDeployWithAgent: (id: number, deployWithAgent: boolean) => ({ id, deployWithAgent }),
    setFrameArchived: (id: number, archived: boolean) => ({ id, archived }),
    toggleArchivedFramesExpanded: true,
    toggleInactiveFramesExpanded: true,
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
        [socketLogic.actionTypes.newLog]: (state, { log }) => {
          const frame = state[log.frame_id]
          if (!frame) {
            return state
          }
          const activeSceneId = activeSceneIdFromLogLine(log.line)
          if (!logUpdatesFrameActivity(log) && !activeSceneId) {
            return state
          }
          const currentLastLogAt = frame.last_log_at ? Date.parse(frame.last_log_at) : NaN
          const nextLastLogAt = Date.parse(log.timestamp)
          const shouldUpdateLastLogAt =
            Number.isFinite(nextLastLogAt) && (!Number.isFinite(currentLastLogAt) || currentLastLogAt < nextLastLogAt)
          if (!shouldUpdateLastLogAt && !activeSceneId) {
            return state
          }
          return {
            ...state,
            [log.frame_id]: {
              ...frame,
              ...(shouldUpdateLastLogAt ? { last_log_at: log.timestamp } : {}),
              ...(activeSceneId ? { active_scene_id: activeSceneId } : {}),
            },
          }
        },
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
    inactiveFramesExpanded: [
      true,
      { persist: true, storageKey: 'framesModel.inactiveFramesExpanded' },
      {
        toggleInactiveFramesExpanded: (state) => !state,
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
      longRunningTasksModel.actions.startTask({
        frameId: id,
        kind: 'render',
        title: 'Rendering frame',
        detail: 'Render request sent',
      })
      try {
        const response = await apiFetch(`/api/frames/${id}/event/render`, { method: 'POST' })
        if (!response.ok) {
          throw new Error('Failed to send render event')
        }
      } catch (error) {
        longRunningTasksModel.actions.taskFailed({
          frameId: id,
          kind: 'render',
          detail: error instanceof Error ? error.message : 'Failed to render frame',
        })
        throw error
      }
    },
    deployFrame: async ({ id, fastDeploy }) => {
      longRunningTasksModel.actions.startTask({
        frameId: id,
        kind: 'deploy',
        title: fastDeploy ? 'Fast deploying frame' : 'Deploying frame',
        detail: 'Deploy request sent',
      })
      try {
        const response = fastDeploy
          ? await apiFetch(`/api/frames/${id}/fast_deploy`, { method: 'POST' })
          : await apiFetch(`/api/frames/${id}/deploy`, { method: 'POST' })
        if (!response.ok) {
          throw new Error(fastDeploy ? 'Failed to start fast deploy' : 'Failed to start deploy')
        }
      } catch (error) {
        longRunningTasksModel.actions.taskFailed({
          frameId: id,
          kind: 'deploy',
          detail: error instanceof Error ? error.message : 'Failed to deploy frame',
        })
        throw error
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
    deployAgent: async ({ id, recompile }) => {
      longRunningTasksModel.actions.startTask({
        frameId: id,
        kind: 'agentDeploy',
        title: recompile ? 'Recompiling and deploying FrameOS agent' : 'Deploying FrameOS agent',
        detail: 'Agent deploy request sent',
      })
      try {
        const response = await apiFetch(`/api/frames/${id}/deploy_agent${recompile ? '?recompile=1' : ''}`, {
          method: 'POST',
        })
        if (!response.ok) {
          throw new Error('Failed to start agent deploy')
        }
      } catch (error) {
        longRunningTasksModel.actions.taskFailed({
          frameId: id,
          kind: 'agentDeploy',
          detail: error instanceof Error ? error.message : 'Failed to deploy agent',
        })
        throw error
      }
    },
    restartAgent: async ({ id }) => {
      longRunningTasksModel.actions.startTask({
        frameId: id,
        kind: 'agentRestart',
        title: 'Restarting FrameOS agent',
        detail: 'Agent restart request sent',
      })
      try {
        const response = await apiFetch(`/api/frames/${id}/restart_agent`, { method: 'POST' })
        if (!response.ok) {
          throw new Error('Failed to start agent restart')
        }
      } catch (error) {
        longRunningTasksModel.actions.taskFailed({
          frameId: id,
          kind: 'agentRestart',
          detail: error instanceof Error ? error.message : 'Failed to restart agent',
        })
        throw error
      }
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
