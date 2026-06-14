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
import { getBasePath } from '../utils/getBasePath'
import { projectApiPathFromCache } from '../utils/projectApi'

export type AgentTaskTransport = 'auto' | 'agent' | 'ssh'
type EmbeddedFirmware = NonNullable<NonNullable<FrameType['embedded']>['firmware']>

function agentTaskQuery(params: { recompile?: boolean; transport?: AgentTaskTransport }): string {
  const query = new URLSearchParams()
  if (params.recompile) {
    query.set('recompile', '1')
  }
  if (params.transport) {
    query.set('transport', params.transport)
  }
  const queryString = query.toString()
  return queryString ? `?${queryString}` : ''
}

function deployTaskId(frameId: number, fastDeploy: boolean): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${fastDeploy ? 'fast-deploy' : 'deploy'}:${frameId}:${random}`
}

function taskIdQuery(taskId: string): string {
  const query = new URLSearchParams()
  query.set('task_id', taskId)
  return `?${query.toString()}`
}

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

function apiDownloadUrl(path: string): string {
  const scopedPath = projectApiPathFromCache(path)
  if (/^https?:\/\//.test(scopedPath)) {
    return scopedPath
  }
  return `${getBasePath()}${scopedPath}`
}

function startBrowserDownload(path: string): void {
  const anchor = document.createElement('a')
  anchor.href = apiDownloadUrl(path)
  anchor.download = ''
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

const pendingSdCardImageDownloads = new Set<number>()
const sdCardImageStatusPollsInFlight = new Set<number>()
const sdCardImageProgressTimers = new Map<number, ReturnType<typeof window.setInterval>>()

const pendingEmbeddedFirmwareDownloads = new Set<number>()
const embeddedFirmwareStatusPollsInFlight = new Set<number>()
const embeddedFirmwareProgressTimers = new Map<number, ReturnType<typeof window.setInterval>>()
const SD_CARD_IMAGE_PROGRESS_INTERVAL_MS = 30 * 1000
const EMBEDDED_FIRMWARE_OTA_POLL_INTERVAL_MS = 3000
const EMBEDDED_FIRMWARE_OTA_TIMEOUT_MS = 10 * 60 * 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

async function responseErrorDetail(response: Response, fallback: string): Promise<string> {
  try {
    return (await response.json())?.detail || fallback
  } catch (error) {
    return fallback
  }
}

function sdCardImageProgressDetail(startedAt: number): string {
  const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes > 0) {
    return `Still preparing SD card image (${elapsedMinutes} min elapsed)`
  }
  return 'Still preparing SD card image'
}

function stopSdCardImageProgress(frameId: number): void {
  const timer = sdCardImageProgressTimers.get(frameId)
  if (timer === undefined || typeof window === 'undefined') {
    return
  }
  window.clearInterval(timer)
  sdCardImageProgressTimers.delete(frameId)
}

async function pollSdCardImageStatus(frameId: number, downloadUrl?: string): Promise<void> {
  if (!pendingSdCardImageDownloads.has(frameId) || sdCardImageStatusPollsInFlight.has(frameId)) {
    return
  }
  sdCardImageStatusPollsInFlight.add(frameId)
  try {
    const response = await apiFetch(`/api/frames/${frameId}/buildroot/sd_image`)
    if (!response.ok) {
      return
    }
    const data = await response.json()
    const sdImage = data?.sdImage as NonNullable<NonNullable<FrameType['buildroot']>['sdImage']> | undefined
    if (!sdImage || !pendingSdCardImageDownloads.has(frameId)) {
      return
    }
    if (sdImage.status === 'ready') {
      pendingSdCardImageDownloads.delete(frameId)
      stopSdCardImageProgress(frameId)
      startBrowserDownload(sdImage.downloadUrl || downloadUrl || `/api/frames/${frameId}/buildroot/sd_image/download`)
      framesModel.actions.loadFrame(frameId)
      longRunningTasksModel.actions.finishTask({
        frameId,
        kind: 'buildrootImage',
        status: 'success',
        detail: 'SD card image ready',
      })
    } else if (sdImage.status === 'error' || sdImage.status === 'missing' || sdImage.status === 'stale') {
      pendingSdCardImageDownloads.delete(frameId)
      stopSdCardImageProgress(frameId)
      framesModel.actions.loadFrame(frameId)
      longRunningTasksModel.actions.taskFailed({
        frameId,
        kind: 'buildrootImage',
        detail: sdImage.error || 'SD card image generation failed',
      })
    }
  } finally {
    sdCardImageStatusPollsInFlight.delete(frameId)
  }
}

function startSdCardImageProgress(frameId: number): void {
  stopSdCardImageProgress(frameId)
  if (typeof window === 'undefined') {
    return
  }
  const startedAt = Date.now()
  const updateProgressDetail = (): void => {
    if (!pendingSdCardImageDownloads.has(frameId)) {
      stopSdCardImageProgress(frameId)
      return
    }
    longRunningTasksModel.actions.updateTaskProgress({
      frameId,
      kind: 'buildrootImage',
      progressCurrent: null,
      progressTotal: null,
      detail: sdCardImageProgressDetail(startedAt),
    })
    void pollSdCardImageStatus(frameId)
  }
  sdCardImageProgressTimers.set(frameId, window.setInterval(updateProgressDetail, SD_CARD_IMAGE_PROGRESS_INTERVAL_MS))
}

const EMBEDDED_FIRMWARE_PROGRESS_INTERVAL_MS = 15 * 1000

function embeddedFirmwareProgressDetail(startedAt: number): string {
  const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes > 0) {
    return `Still building firmware (${elapsedMinutes} min elapsed)`
  }
  return 'Still building firmware'
}

function stopEmbeddedFirmwareProgress(frameId: number): void {
  const timer = embeddedFirmwareProgressTimers.get(frameId)
  if (timer === undefined || typeof window === 'undefined') {
    return
  }
  window.clearInterval(timer)
  embeddedFirmwareProgressTimers.delete(frameId)
}

async function pollEmbeddedFirmwareStatus(frameId: number, downloadUrl?: string): Promise<void> {
  if (!pendingEmbeddedFirmwareDownloads.has(frameId) || embeddedFirmwareStatusPollsInFlight.has(frameId)) {
    return
  }
  embeddedFirmwareStatusPollsInFlight.add(frameId)
  try {
    const response = await apiFetch(`/api/frames/${frameId}/embedded/firmware`)
    if (!response.ok) {
      return
    }
    const data = await response.json()
    const firmware = data?.firmware as NonNullable<NonNullable<FrameType['embedded']>['firmware']> | undefined
    if (!firmware || !pendingEmbeddedFirmwareDownloads.has(frameId)) {
      return
    }
    if (firmware.status === 'ready') {
      pendingEmbeddedFirmwareDownloads.delete(frameId)
      stopEmbeddedFirmwareProgress(frameId)
      startBrowserDownload(firmware.downloadUrl || downloadUrl || `/api/frames/${frameId}/embedded/firmware/download`)
      framesModel.actions.loadFrame(frameId)
      longRunningTasksModel.actions.finishTask({
        frameId,
        kind: 'embeddedFirmware',
        status: 'success',
        detail: 'Firmware image ready',
      })
    } else if (firmware.status === 'error' || firmware.status === 'missing' || firmware.status === 'stale') {
      pendingEmbeddedFirmwareDownloads.delete(frameId)
      stopEmbeddedFirmwareProgress(frameId)
      framesModel.actions.loadFrame(frameId)
      longRunningTasksModel.actions.taskFailed({
        frameId,
        kind: 'embeddedFirmware',
        detail: firmware.error || 'Firmware build failed',
      })
    }
  } finally {
    embeddedFirmwareStatusPollsInFlight.delete(frameId)
  }
}

async function fetchEmbeddedFirmwareStatus(frameId: number): Promise<EmbeddedFirmware | null> {
  const response = await apiFetch(`/api/frames/${frameId}/embedded/firmware`)
  if (!response.ok) {
    throw new Error(await responseErrorDetail(response, 'Failed to fetch firmware status'))
  }
  const data = await response.json()
  return (data?.firmware as EmbeddedFirmware | undefined) ?? null
}

async function ensureEmbeddedFirmwareReadyForOta(frameId: number, force: boolean): Promise<EmbeddedFirmware> {
  const startedAt = Date.now()
  const response = await apiFetch(`/api/frames/${frameId}/embedded/firmware${force ? '?force=1' : ''}`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await responseErrorDetail(response, 'Failed to start firmware build'))
  }

  const data = await response.json()
  let firmware = (data?.firmware as EmbeddedFirmware | undefined) ?? null
  while (firmware?.status !== 'ready') {
    if (firmware?.status === 'error' || firmware?.status === 'missing' || firmware?.status === 'stale') {
      throw new Error(firmware.error || 'Firmware build failed')
    }
    if (Date.now() - startedAt > EMBEDDED_FIRMWARE_OTA_TIMEOUT_MS) {
      throw new Error('Timed out waiting for firmware build')
    }
    longRunningTasksModel.actions.updateTaskProgress({
      frameId,
      kind: 'embeddedOta',
      progressCurrent: null,
      progressTotal: null,
      detail: embeddedFirmwareProgressDetail(startedAt),
    })
    await sleep(EMBEDDED_FIRMWARE_OTA_POLL_INTERVAL_MS)
    firmware = await fetchEmbeddedFirmwareStatus(frameId)
  }
  return firmware
}

function startEmbeddedFirmwareProgress(frameId: number): void {
  stopEmbeddedFirmwareProgress(frameId)
  if (typeof window === 'undefined') {
    return
  }
  const startedAt = Date.now()
  const updateProgressDetail = (): void => {
    if (!pendingEmbeddedFirmwareDownloads.has(frameId)) {
      stopEmbeddedFirmwareProgress(frameId)
      return
    }
    longRunningTasksModel.actions.updateTaskProgress({
      frameId,
      kind: 'embeddedFirmware',
      progressCurrent: null,
      progressTotal: null,
      detail: embeddedFirmwareProgressDetail(startedAt),
    })
    void pollEmbeddedFirmwareStatus(frameId)
  }
  embeddedFirmwareProgressTimers.set(
    frameId,
    window.setInterval(updateProgressDetail, EMBEDDED_FIRMWARE_PROGRESS_INTERVAL_MS)
  )
}

export const framesModel = kea<framesModelType>([
  connect(() => ({ logic: [socketLogic, entityImagesModel] })),
  path(['src', 'models', 'framesModel']),
  actions({
    addFrame: (frame: FrameType) => ({ frame }),
    loadFrame: (id: number) => ({ id }),
    deployFrame: (id: number, fastDeploy?: boolean) => ({ id, fastDeploy: fastDeploy || false }),
    cancelDeploy: (id: number) => ({ id }),
    stopFrame: (id: number) => ({ id }),
    restartFrame: (id: number) => ({ id }),
    rebootFrame: (id: number) => ({ id }),
    renderFrame: (id: number) => ({ id }),
    deleteFrame: (id: number) => ({ id }),
    renameFrame: (id: number, name: string) => ({ id, name }),
    deployAgent: (id: number, recompile?: boolean, transport: AgentTaskTransport = 'auto') => ({
      id,
      recompile: recompile || false,
      transport,
    }),
    restartAgent: (id: number, transport: AgentTaskTransport = 'auto') => ({ id, transport }),
    downloadSdCardImage: (id: number) => ({ id }),
    downloadEmbeddedFirmware: (id: number) => ({ id }),
    applyEmbeddedFirmwareOta: (id: number, force?: boolean) => ({ id, force: force || false }),
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
      const taskId = deployTaskId(id, fastDeploy)
      longRunningTasksModel.actions.startTask({
        id: taskId,
        frameId: id,
        kind: 'deploy',
        title: fastDeploy ? 'Fast deploying frame' : 'Deploying frame',
        detail: 'Deploy request sent',
      })
      try {
        const response = fastDeploy
          ? await apiFetch(`/api/frames/${id}/fast_deploy${taskIdQuery(taskId)}`, { method: 'POST' })
          : await apiFetch(`/api/frames/${id}/deploy${taskIdQuery(taskId)}`, { method: 'POST' })
        if (!response.ok) {
          throw new Error(fastDeploy ? 'Failed to start fast deploy' : 'Failed to start deploy')
        }
      } catch (error) {
        longRunningTasksModel.actions.taskFailed({
          taskId,
          frameId: id,
          kind: 'deploy',
          detail: error instanceof Error ? error.message : 'Failed to deploy frame',
        })
        throw error
      }
    },
    cancelDeploy: async ({ id }) => {
      const response = await apiFetch(`/api/frames/${id}/cancel_deploy`, { method: 'POST' })
      if (!response.ok) {
        throw new Error('Failed to cancel deploy')
      }
      longRunningTasksModel.actions.taskFailed({
        frameId: id,
        kind: 'deploy',
        detail: 'Deploy cancelled',
      })
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
    deployAgent: async ({ id, recompile, transport }) => {
      longRunningTasksModel.actions.startTask({
        frameId: id,
        kind: 'agentDeploy',
        title: recompile ? 'Recompiling and deploying FrameOS agent' : 'Deploying FrameOS agent',
        detail: 'Agent deploy request sent',
      })
      try {
        const response = await apiFetch(`/api/frames/${id}/deploy_agent${agentTaskQuery({ recompile, transport })}`, {
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
    restartAgent: async ({ id, transport }) => {
      longRunningTasksModel.actions.startTask({
        frameId: id,
        kind: 'agentRestart',
        title: 'Restarting FrameOS agent',
        detail: 'Agent restart request sent',
      })
      try {
        const response = await apiFetch(`/api/frames/${id}/restart_agent${agentTaskQuery({ transport })}`, {
          method: 'POST',
        })
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
    downloadSdCardImage: async ({ id }) => {
      const frame = values.frames[id]
      const sdImage = frame?.buildroot?.sdImage
      const downloadUrl = sdImage?.downloadUrl || `/api/frames/${id}/buildroot/sd_image/download`

      pendingSdCardImageDownloads.add(id)
      startSdCardImageProgress(id)
      longRunningTasksModel.actions.startTask({
        frameId: id,
        kind: 'buildrootImage',
        title: 'Preparing SD card image',
        detail:
          sdImage?.status === 'building' || sdImage?.status === 'queued'
            ? 'Checking image build status'
            : 'Image preparation started',
      })

      try {
        const response = await apiFetch(`/api/frames/${id}/buildroot/sd_image`, {
          method: 'POST',
        })
        if (!response.ok) {
          throw new Error('Failed to start SD card image generation')
        }
        const data = await response.json()
        if (data?.sdImage?.status === 'ready') {
          pendingSdCardImageDownloads.delete(id)
          stopSdCardImageProgress(id)
          startBrowserDownload(data.sdImage.downloadUrl || downloadUrl)
          longRunningTasksModel.actions.finishTask({
            frameId: id,
            kind: 'buildrootImage',
            status: 'success',
            detail: 'SD card image ready',
          })
          return
        }
        void pollSdCardImageStatus(id, downloadUrl)
      } catch (error) {
        pendingSdCardImageDownloads.delete(id)
        stopSdCardImageProgress(id)
        longRunningTasksModel.actions.taskFailed({
          frameId: id,
          kind: 'buildrootImage',
          detail: error instanceof Error ? error.message : 'Failed to build SD card image',
        })
        throw error
      }
    },
    downloadEmbeddedFirmware: async ({ id }) => {
      const frame = values.frames[id]
      const firmware = frame?.embedded?.firmware
      const downloadUrl = firmware?.downloadUrl || `/api/frames/${id}/embedded/firmware/download`

      pendingEmbeddedFirmwareDownloads.add(id)
      startEmbeddedFirmwareProgress(id)
      longRunningTasksModel.actions.startTask({
        frameId: id,
        kind: 'embeddedFirmware',
        title: 'Building firmware image',
        detail:
          firmware?.status === 'building' || firmware?.status === 'queued'
            ? 'Checking firmware build status'
            : 'Firmware build started',
      })

      try {
        const response = await apiFetch(`/api/frames/${id}/embedded/firmware`, {
          method: 'POST',
        })
        if (!response.ok) {
          let detail = 'Failed to start firmware build'
          try {
            detail = (await response.json())?.detail || detail
          } catch (error) {}
          throw new Error(detail)
        }
        const data = await response.json()
        if (data?.firmware?.status === 'ready') {
          pendingEmbeddedFirmwareDownloads.delete(id)
          stopEmbeddedFirmwareProgress(id)
          startBrowserDownload(data.firmware.downloadUrl || downloadUrl)
          longRunningTasksModel.actions.finishTask({
            frameId: id,
            kind: 'embeddedFirmware',
            status: 'success',
            detail: 'Firmware image ready',
          })
          return
        }
        void pollEmbeddedFirmwareStatus(id, downloadUrl)
      } catch (error) {
        pendingEmbeddedFirmwareDownloads.delete(id)
        stopEmbeddedFirmwareProgress(id)
        longRunningTasksModel.actions.taskFailed({
          frameId: id,
          kind: 'embeddedFirmware',
          detail: error instanceof Error ? error.message : 'Failed to build firmware image',
        })
        throw error
      }
    },
    applyEmbeddedFirmwareOta: async ({ id, force }) => {
      const frame = values.frames[id]
      const firmware = frame?.embedded?.firmware
      longRunningTasksModel.actions.startTask({
        frameId: id,
        kind: 'embeddedOta',
        title: 'Applying OTA update',
        detail:
          firmware?.status === 'ready' && !force
            ? 'Requesting OTA update'
            : firmware?.status === 'building' || firmware?.status === 'queued'
              ? 'Waiting for firmware build'
              : 'Preparing firmware image',
      })

      try {
        await ensureEmbeddedFirmwareReadyForOta(id, force)
        longRunningTasksModel.actions.updateTaskProgress({
          frameId: id,
          kind: 'embeddedOta',
          progressCurrent: null,
          progressTotal: null,
          detail: 'Requesting OTA update',
        })
        const response = await apiFetch(`/api/frames/${id}/embedded/firmware/ota`, { method: 'POST' })
        if (!response.ok) {
          throw new Error(await responseErrorDetail(response, 'Failed to request OTA update'))
        }
        longRunningTasksModel.actions.finishTask({
          frameId: id,
          kind: 'embeddedOta',
          status: 'success',
          detail: 'OTA update requested',
        })
        actions.loadFrame(id)
      } catch (error) {
        longRunningTasksModel.actions.taskFailed({
          frameId: id,
          kind: 'embeddedOta',
          detail: error instanceof Error ? error.message : 'Failed to apply OTA update',
        })
        actions.loadFrame(id)
        throw error
      }
    },
    [socketLogic.actionTypes.socketReconnected]: () => {
      // Frame state is event-sourced over the websocket; anything that
      // happened while disconnected (backend deploys drop the socket at
      // exactly the moment statuses change) was missed, so refetch.
      actions.loadFrames()
    },
    [socketLogic.actionTypes.updateFrame]: ({ frame }) => {
      const sdImage = frame.buildroot?.sdImage
      if (sdImage && pendingSdCardImageDownloads.has(frame.id)) {
        if (sdImage.status === 'ready') {
          pendingSdCardImageDownloads.delete(frame.id)
          stopSdCardImageProgress(frame.id)
          startBrowserDownload(sdImage.downloadUrl || `/api/frames/${frame.id}/buildroot/sd_image/download`)
        } else if (sdImage.status === 'error' || sdImage.status === 'missing' || sdImage.status === 'stale') {
          pendingSdCardImageDownloads.delete(frame.id)
          stopSdCardImageProgress(frame.id)
        }
      }
      const firmware = frame.embedded?.firmware
      if (firmware && pendingEmbeddedFirmwareDownloads.has(frame.id)) {
        if (firmware.status === 'ready') {
          pendingEmbeddedFirmwareDownloads.delete(frame.id)
          stopEmbeddedFirmwareProgress(frame.id)
          startBrowserDownload(firmware.downloadUrl || `/api/frames/${frame.id}/embedded/firmware/download`)
          longRunningTasksModel.actions.finishTask({
            frameId: frame.id,
            kind: 'embeddedFirmware',
            status: 'success',
            detail: 'Firmware image ready',
          })
        } else if (firmware.status === 'error' || firmware.status === 'missing' || firmware.status === 'stale') {
          pendingEmbeddedFirmwareDownloads.delete(frame.id)
          stopEmbeddedFirmwareProgress(frame.id)
          longRunningTasksModel.actions.taskFailed({
            frameId: frame.id,
            kind: 'embeddedFirmware',
            detail: firmware.error || 'Firmware build failed',
          })
        }
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
        let parsed: any
        try {
          parsed = JSON.parse(log.line)
        } catch {
          // A malformed webhook line must not throw out of the listener (which
          // would skip the rest of the newLog listener chain for this action).
          return
        }
        if (parsed.event == 'render:dither' || parsed.event == 'render:done' || parsed.event == 'server:start') {
          entityImagesModel.actions.updateEntityImage(`frames/${log.frame_id}`, 'image')
        }
      }
    },
  })),
])
