import {
  MakeLogicType,
  actions,
  afterMount,
  beforeUnmount,
  connect,
  kea,
  listeners,
  path,
  reducers,
  selectors,
} from 'kea'
import { loaders } from 'kea-loaders'
import { CloudSceneSource, FrameScene, FrameType, FrameId } from '../types'
import { socketLogic } from '../scenes/socketLogic'
import { router } from 'kea-router'
import { frameLogic, sanitizeScene } from '../scenes/frame/frameLogic'
import { compareFrames } from '../utils/frameSort'
import { apiFetch, logApiError } from '../utils/apiFetch'
import { isCloudMode } from '../utils/cloudMode'
import {
  sendCloudFrameCommand,
  listCloudFrameScenes,
  deployCloudFrameScenes,
  cloudDeployActiveSceneId,
} from '../utils/cloudFrameApi'
import {
  activeSceneFromLastState,
  cloudSceneCacheKey,
  cloudSceneStub,
  scenesFromStoreSceneJson,
} from '../utils/cloudFrameScenes'
import { entityImagesModel } from './entityImagesModel'
import { urls } from '../urls'
import { logUpdatesFrameActivity } from '../decorators/frame'
import { longRunningTasksModel } from './longRunningTasksModel'
import { getBasePath } from '../utils/getBasePath'
import { projectApiPathFromCache } from '../utils/projectApi'
import {
  embeddedUsbApiCanUse,
  embeddedUsbLogsModel,
  runEmbeddedUsbApiCommand,
  usbRestart,
} from './embeddedUsbLogsModel'
import { frameSupportsUsbSerialConsole } from '../scenes/workspace/workspaceSurfaces'
import type { FrameEmbeddedFlashSize } from '../types'

export type RemoteTaskTransport = 'auto' | 'remote' | 'ssh'
export type EmbeddedFirmware = NonNullable<NonNullable<FrameType['embedded']>['firmware']>

function remoteTaskQuery(params: { recompile?: boolean; transport?: RemoteTaskTransport }): string {
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

function deployTaskId(frameId: FrameId, fastDeploy: boolean): string {
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
    // Cloud rows report the device's current scene under last_state (the hub
    // writes it); the backend's newLog-based inference below never fires
    // there, so without this the Active badge stays dark after a reload.
    active_scene_id: frame.active_scene_id ?? activeSceneFromLastState(frame.last_state) ?? undefined,
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
  // compareFrames is null-safe: cloud frames have no frame_host, and a
  // freshly enrolled one can lack a name too — sorting one used to throw
  // inside the fleet selectors and white-screen the workspace.
  return frames.sort(compareFrames)
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

// Cloud scene hydration. Cloud frame payloads are frameSummary rows with no
// scene JSON at all — the scene list lives server-side as store-scene
// assignments. The tiles hydrate from GET /api/frames/{id}/scenes plus each
// store scene's /api/store/scenes/{scene_id}/scenes.json (the exact payload
// the device receives over set_scenes, so the tile ids match the runtime ids
// the device reports as active_scene). scenes.json bodies are cached per
// store scene id + version so the 15s fleet poll re-checks assignments
// without refetching scene bodies; the assignment list itself is only
// re-listed once a minute per frame unless forced (install flow), keeping
// well under the endpoint's 240/15min rate limit.
const cloudSceneJsonCache = new Map<string, FrameScene[]>()
const cloudFrameSceneHydrationsInFlight = new Set<FrameId>()
const cloudFrameScenesHydratedAt = new Map<FrameId, number>()
const CLOUD_FRAME_SCENES_REFRESH_MS = 60_000

/**
 * Drop cached scenes.json bodies for one store scene (all pinned versions and
 * 'latest'). A content save publishes a new version, and the '@latest' cache
 * key would otherwise keep serving the pre-save body until a reload.
 */
export function clearCloudSceneJsonCache(storeSceneId: string): void {
  for (const key of [...cloudSceneJsonCache.keys()]) {
    if (key.startsWith(`${storeSceneId}@`)) {
      cloudSceneJsonCache.delete(key)
    }
  }
}

async function fetchCloudFrameScenes(
  frameId: FrameId
): Promise<{ scenes: FrameScene[]; sources: Record<string, CloudSceneSource> }> {
  const rows = await listCloudFrameScenes(frameId)
  const scenes: FrameScene[] = []
  // Runtime scene id → the store-scene assignment it came from. This is the
  // only place both id spaces are visible at once, and the per-scene deploy
  // ledger (assigned_scene_state / deployed_scene_state) is keyed by store
  // scene id while the tiles are runtime scenes.
  const sources: Record<string, CloudSceneSource> = {}
  for (const row of rows) {
    const cacheKey = cloudSceneCacheKey(row)
    let sceneJson = cloudSceneJsonCache.get(cacheKey)
    if (!sceneJson) {
      try {
        // A pinned assignment shows the pinned version's content — the
        // device runs that one, not the store's latest.
        const version = row.scene_version ? `?version=${row.scene_version}` : ''
        const response = await apiFetch(`/api/store/scenes/${row.scene_id}/scenes.json${version}`)
        const parsed = response.ok ? scenesFromStoreSceneJson(await response.json()) : null
        if (parsed) {
          cloudSceneJsonCache.set(cacheKey, parsed)
          sceneJson = parsed
        }
      } catch (error) {
        // Fall through to the stub. Failures are deliberately not cached, so
        // a transient error heals on the next hydration pass.
      }
    }
    const rowScenes = sceneJson ?? [cloudSceneStub(row)]
    for (const scene of rowScenes) {
      sources[scene.id] = { scene_id: row.scene_id, scene_version: row.scene_version ?? null }
    }
    scenes.push(...rowScenes)
  }
  return { scenes, sources }
}

/**
 * Cloud only: a frame refetch (15s fleet poll, hub broadcast) always arrives
 * without scenes; it must not blank the hydrated tiles for the seconds until
 * the next hydration lands. Backend frames carry their scenes inline, and a
 * non-empty incoming list always wins, so this never masks real data.
 */
function withStoredCloudScenes(next: FrameType, previous?: FrameType): FrameType {
  if (!isCloudMode() || next.scenes?.length || !previous?.scenes?.length) {
    return next
  }
  // cloud_scene_sources is hydration-owned client state; a frameSummary
  // refetch never carries it, so keep it alongside the scenes it describes.
  return { ...next, scenes: previous.scenes, cloud_scene_sources: previous.cloud_scene_sources }
}

const pendingSdCardImageDownloads = new Set<FrameId>()
const sdCardImageStatusPollsInFlight = new Set<FrameId>()
const sdCardImageProgressTimers = new Map<FrameId, ReturnType<typeof window.setInterval>>()

const pendingEmbeddedFirmwareDownloads = new Set<FrameId>()
const embeddedFirmwareStatusPollsInFlight = new Set<FrameId>()
const embeddedFirmwareProgressTimers = new Map<FrameId, ReturnType<typeof window.setInterval>>()
const embeddedFirmwareRecoveryAttempts = new Map<FrameId, number>()
const EMBEDDED_FIRMWARE_RECOVERY_ATTEMPT_LIMIT = 2
const embeddedUsbImageRefreshTimers = new Map<FrameId, ReturnType<typeof window.setTimeout>>()
const embeddedUsbImageRefreshesInFlight = new Set<FrameId>()
const embeddedUsbImageRefreshRetries = new Map<FrameId, number>()
const EMBEDDED_USB_IMAGE_REFRESH_DELAY_MS = 1500
const EMBEDDED_USB_IMAGE_REFRESH_TIMEOUT_MS = 45000
// The first render after a deploy takes minutes on e-paper; keep asking
// until a preview exists (12 x 20s covers the slowest panels)
const EMBEDDED_USB_IMAGE_RETRY_DELAY_MS = 20000
const EMBEDDED_USB_IMAGE_RETRY_LIMIT = 12
const EMBEDDED_USB_UPLOAD_MIN_TIMEOUT_MS = 45000
const EMBEDDED_USB_UPLOAD_BASE_TIMEOUT_MS = 30000
const EMBEDDED_USB_UPLOAD_TIMEOUT_MS_PER_KB = 250
const SD_CARD_IMAGE_PROGRESS_INTERVAL_MS = 30 * 1000

export function embeddedUsbUploadTimeoutMs(payloadBytes: number): number {
  return Math.max(
    EMBEDDED_USB_UPLOAD_MIN_TIMEOUT_MS,
    EMBEDDED_USB_UPLOAD_BASE_TIMEOUT_MS + Math.ceil(payloadBytes / 1024) * EMBEDDED_USB_UPLOAD_TIMEOUT_MS_PER_KB
  )
}

async function responseErrorDetail(response: Response, fallback: string): Promise<string> {
  try {
    return (await response.json())?.detail || fallback
  } catch (error) {
    return fallback
  }
}

function mergeEmbeddedFirmwareStatus(
  current: EmbeddedFirmware | undefined,
  firmware: EmbeddedFirmware
): EmbeddedFirmware {
  if (!current) {
    return firmware
  }
  return {
    ...firmware,
    layout: firmware.layout ?? current.layout,
  }
}

async function requestEmbeddedFirmwareBuild(frameId: FrameId, force = false): Promise<EmbeddedFirmware | null> {
  const response = await apiFetch(`/api/frames/${frameId}/embedded/firmware${force ? '?force=1' : ''}`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await responseErrorDetail(response, 'Failed to start firmware build'))
  }
  const data = await response.json()
  return (data?.firmware as EmbeddedFirmware | undefined) ?? null
}

async function recoverEmbeddedFirmwareBuild(frameId: FrameId, status: EmbeddedFirmware): Promise<boolean> {
  if (status.status !== 'stale' && status.status !== 'missing') {
    return false
  }
  const attempts = embeddedFirmwareRecoveryAttempts.get(frameId) ?? 0
  if (attempts >= EMBEDDED_FIRMWARE_RECOVERY_ATTEMPT_LIMIT) {
    return false
  }
  embeddedFirmwareRecoveryAttempts.set(frameId, attempts + 1)
  longRunningTasksModel.actions.updateTaskProgress({
    frameId,
    kind: 'embeddedFirmware',
    progressCurrent: null,
    progressTotal: null,
    detail:
      status.status === 'stale' ? 'Rebuilding firmware from current settings' : 'Rebuilding missing firmware image',
  })
  const firmware = await requestEmbeddedFirmwareBuild(frameId, true)
  if (firmware) {
    framesModel.actions.updateEmbeddedFirmwareStatus(frameId, firmware)
  }
  return true
}

function usbLogLineIndicatesImageReady(line: string): boolean {
  const normalized = line.toLowerCase()
  return (
    normalized.includes('render:done') ||
    /render #\d+ done\b/.test(normalized) ||
    normalized.includes('display refresh skipped: packed image unchanged') ||
    normalized.includes('driver:waveshare:debug action="sleep:done"') ||
    normalized.includes("driver:waveshare:debug action='sleep:done'") ||
    normalized.includes('driver:waveshare:debug action="turnondisplay:done"') ||
    normalized.includes("driver:waveshare:debug action='turnondisplay:done'")
  )
}

function embeddedUsbImageSceneId(metadata?: string): string | null {
  const match = metadata?.match(/(?:^|\s)scene=([^\s]*)/)
  const sceneId = match?.[1]?.trim()
  return sceneId || null
}

async function refreshEmbeddedUsbFrameImage(frameId: FrameId): Promise<void> {
  if (embeddedUsbImageRefreshesInFlight.has(frameId) || !embeddedUsbApiCanUse(frameId)) {
    return
  }
  embeddedUsbImageRefreshesInFlight.add(frameId)
  try {
    const result = await runEmbeddedUsbApiCommand(frameId, 'image', {
      timeoutMs: EMBEDDED_USB_IMAGE_REFRESH_TIMEOUT_MS,
    })
    if (!result.bytes?.byteLength) {
      throw new Error('USB image command returned no image bytes')
    }
    const sceneId = embeddedUsbImageSceneId(result.metadata)
    const query = sceneId ? `?scene_id=${encodeURIComponent(sceneId)}` : ''
    const imageBuffer = result.bytes.buffer.slice(
      result.bytes.byteOffset,
      result.bytes.byteOffset + result.bytes.byteLength
    ) as ArrayBuffer
    const response = await apiFetch(`/api/frames/${frameId}/image${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/bmp' },
      body: new Blob([imageBuffer], { type: 'image/bmp' }),
    })
    if (!response.ok) {
      throw new Error(await responseErrorDetail(response, 'Failed to update frame image from USB'))
    }
    entityImagesModel.actions.updateEntityImage(`frames/${frameId}`, 'image')
    if (sceneId) {
      entityImagesModel.actions.updateEntityImage(`frames/${frameId}`, `scene_images/${sceneId}`)
    }
    socketLogic.actions.frameRendered(frameId)
    embeddedUsbImageRefreshRetries.delete(frameId)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const retryable =
      // Expected right after a deploy: the first render is still in progress.
      /no preview rendered yet|preview snapshot was not retained/i.test(detail) ||
      // Expected under load: a console log line interleaved with the serial
      // payload dump (UsbPayloadCorruptedError). The next transfer usually
      // lands in a quiet window.
      (error instanceof Error && error.name === 'UsbPayloadCorruptedError')
    if (retryable) {
      const attempts = (embeddedUsbImageRefreshRetries.get(frameId) ?? 0) + 1
      if (attempts <= EMBEDDED_USB_IMAGE_RETRY_LIMIT) {
        embeddedUsbImageRefreshRetries.set(frameId, attempts)
        scheduleEmbeddedUsbFrameImageRefresh(frameId, EMBEDDED_USB_IMAGE_RETRY_DELAY_MS)
      } else {
        embeddedUsbImageRefreshRetries.delete(frameId)
      }
    } else {
      console.warn('Failed to update frame image over USB', error)
    }
  } finally {
    embeddedUsbImageRefreshesInFlight.delete(frameId)
  }
}

/**
 * Restart/Reboot fallback for embedded frames: when the network path fails
 * but a USB serial session is connected, reboot the board over the console.
 * Returns true when the USB restart succeeded.
 */
async function restartEmbeddedFrameOverUsb(frameId: FrameId, frame?: FrameType): Promise<boolean> {
  const isEmbedded = (frame?.mode ?? 'rpios') === 'embedded' || frameSupportsUsbSerialConsole(frame)
  if (!isEmbedded || !embeddedUsbApiCanUse(frameId)) {
    return false
  }
  try {
    await usbRestart(frameId)
    return true
  } catch (error) {
    // Stale/busy USB port — let the caller surface the original network error.
    return false
  }
}

export function scheduleEmbeddedUsbFrameImageRefresh(
  frameId: FrameId,
  delayMs: number = EMBEDDED_USB_IMAGE_REFRESH_DELAY_MS
): void {
  if (!embeddedUsbApiCanUse(frameId) || typeof window === 'undefined') {
    return
  }
  const existingTimer = embeddedUsbImageRefreshTimers.get(frameId)
  if (existingTimer !== undefined) {
    window.clearTimeout(existingTimer)
  }
  embeddedUsbImageRefreshTimers.set(
    frameId,
    window.setTimeout(() => {
      embeddedUsbImageRefreshTimers.delete(frameId)
      void refreshEmbeddedUsbFrameImage(frameId)
    }, delayMs)
  )
}

function sdCardImageProgressDetail(startedAt: number): string {
  const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes > 0) {
    return `Still preparing SD card image (${elapsedMinutes} min elapsed)`
  }
  return 'Still preparing SD card image'
}

function stopSdCardImageProgress(frameId: FrameId): void {
  const timer = sdCardImageProgressTimers.get(frameId)
  if (timer === undefined || typeof window === 'undefined') {
    return
  }
  window.clearInterval(timer)
  sdCardImageProgressTimers.delete(frameId)
}

async function pollSdCardImageStatus(frameId: FrameId, downloadUrl?: string): Promise<void> {
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

function startSdCardImageProgress(frameId: FrameId): void {
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

function stopEmbeddedFirmwareProgress(frameId: FrameId): void {
  const timer = embeddedFirmwareProgressTimers.get(frameId)
  if (timer === undefined || typeof window === 'undefined') {
    return
  }
  window.clearInterval(timer)
  embeddedFirmwareProgressTimers.delete(frameId)
}

async function pollEmbeddedFirmwareStatus(frameId: FrameId, downloadUrl?: string): Promise<void> {
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
    framesModel.actions.updateEmbeddedFirmwareStatus(frameId, firmware)
    if (firmware.status === 'ready') {
      pendingEmbeddedFirmwareDownloads.delete(frameId)
      embeddedFirmwareRecoveryAttempts.delete(frameId)
      stopEmbeddedFirmwareProgress(frameId)
      startBrowserDownload(firmware.downloadUrl || downloadUrl || `/api/frames/${frameId}/embedded/firmware/download`)
      framesModel.actions.loadFrame(frameId)
      longRunningTasksModel.actions.finishTask({
        frameId,
        kind: 'embeddedFirmware',
        status: 'success',
        detail: 'Firmware image ready',
      })
    } else if (firmware.status === 'missing' || firmware.status === 'stale') {
      if (await recoverEmbeddedFirmwareBuild(frameId, firmware)) {
        return
      }
      pendingEmbeddedFirmwareDownloads.delete(frameId)
      embeddedFirmwareRecoveryAttempts.delete(frameId)
      stopEmbeddedFirmwareProgress(frameId)
      framesModel.actions.loadFrame(frameId)
      longRunningTasksModel.actions.taskFailed({
        frameId,
        kind: 'embeddedFirmware',
        detail: firmware.error || 'Firmware image needs to be rebuilt',
      })
    } else if (firmware.status === 'error') {
      pendingEmbeddedFirmwareDownloads.delete(frameId)
      embeddedFirmwareRecoveryAttempts.delete(frameId)
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

function startEmbeddedFirmwareProgress(frameId: FrameId): void {
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

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface framesModelValues {
  activeFramesList: FrameType[]
  archivedFramesExpanded: boolean
  archivedFramesList: FrameType[]
  cloudFrameConfirmErrors: Record<FrameId, string>
  cloudFramesConfirming: Record<FrameId, boolean>
  frames: Record<FrameId, FrameType>
  framesEverLoaded: boolean
  framesList: FrameType[]
  framesLoaded: boolean
  framesLoading: boolean
  inactiveFramesExpanded: boolean
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface framesModelActions {
  addFrame: (frame: FrameType) => {
    frame: FrameType
  }
  applyEmbeddedFirmwareOta: (
    id: FrameId,
    force?: boolean
  ) => {
    force: boolean
    id: FrameId
  }
  cancelDeploy: (id: FrameId) => {
    id: FrameId
  }
  confirmCloudFrame: (id: FrameId) => {
    id: FrameId
  }
  confirmCloudFrameFailure: (
    id: FrameId,
    error: string
  ) => {
    error: string
    id: FrameId
  }
  deleteFrame: (id: FrameId) => {
    id: FrameId
  }
  deployFrame: (
    id: FrameId,
    fastDeploy?: boolean
  ) => {
    fastDeploy: boolean
    id: FrameId
  }
  deployRemote: (
    id: FrameId,
    recompile?: boolean,
    transport?: RemoteTaskTransport
  ) => {
    id: FrameId
    recompile: boolean
    transport: RemoteTaskTransport
  }
  downloadEmbeddedFirmware: (id: FrameId) => {
    id: FrameId
  }
  downloadSdCardImage: (id: FrameId) => {
    id: FrameId
  }
  hydrateCloudFrameScenes: (
    id: FrameId,
    force?: boolean
  ) => {
    force: boolean
    id: FrameId
  }
  loadFrame: (id: FrameId) => {
    id: FrameId
  }
  loadFrameFailure: (
    error: string,
    errorObject?: any
  ) => {
    error: string
    errorObject?: any
  }
  loadFrameSuccess: (
    frames: Record<FrameId, FrameType>,
    payload?: {
      id: FrameId
    }
  ) => {
    frames: Record<FrameId, FrameType>
    payload?: {
      id: FrameId
    }
  }
  loadFrames: () => any
  loadFramesFailure: (
    error: string,
    errorObject?: any
  ) => {
    error: string
    errorObject?: any
  }
  loadFramesSuccess: (
    frames: Record<FrameId, FrameType>,
    payload?: any
  ) => {
    frames: Record<FrameId, FrameType>
    payload?: any
  }
  rebootFrame: (id: FrameId) => {
    id: FrameId
  }
  renameFrame: (
    id: FrameId,
    name: string
  ) => {
    id: FrameId
    name: string
  }
  renderFrame: (id: FrameId) => {
    id: FrameId
  }
  restartFrame: (id: FrameId) => {
    id: FrameId
  }
  restartRemote: (
    id: FrameId,
    transport?: RemoteTaskTransport
  ) => {
    id: FrameId
    transport: RemoteTaskTransport
  }
  setCloudFrameScenes: (
    id: FrameId,
    scenes: FrameScene[],
    sources?: Record<string, CloudSceneSource>
  ) => {
    id: FrameId
    scenes: FrameScene[]
    sources: Record<string, CloudSceneSource> | undefined
  }
  setDeployWithAgent: (
    id: FrameId,
    deployWithAgent: boolean
  ) => {
    deployWithAgent: boolean
    id: FrameId
  }
  setFrameArchived: (
    id: FrameId,
    archived: boolean
  ) => {
    archived: boolean
    id: FrameId
  }
  stopFrame: (id: FrameId) => {
    id: FrameId
  }
  toggleArchivedFramesExpanded: () => {
    value: true
  }
  toggleInactiveFramesExpanded: () => {
    value: true
  }
  updateEmbeddedFirmwareStatus: (
    id: FrameId,
    firmware: EmbeddedFirmware
  ) => {
    firmware: {
      appSize?: number | undefined
      bootloaderSize?: number | undefined
      buildProgress?:
        | {
            done: number
            percent: number
            total: number
          }
        | undefined
      completedAt?: string | undefined
      downloadUrl?: string | undefined
      error?: string | undefined
      filename?: string | undefined
      flashBytes?: number | undefined
      flashOffset?: string | undefined
      flashSize?: FrameEmbeddedFlashSize | undefined
      lastHeartbeatAt?: string | undefined
      layout?:
        | {
            flash?:
              | {
                  appBinaryBytes?: number | null | undefined
                  flashBytes?: number | undefined
                  flashOffset?: string | undefined
                  flashSize?: FrameEmbeddedFlashSize | undefined
                  mergedBinaryBytes?: number | null | undefined
                  otaBinaryBytes?: number | null | undefined
                  otaSupported?: boolean | undefined
                  partitions?:
                    | {
                        appSlot?: boolean | undefined
                        end?: number | undefined
                        name: string
                        offset: number
                        size: number
                        subtype?: string | undefined
                        type?: string | undefined
                        usedBytes?: number | null | undefined
                      }[]
                    | undefined
                  partitionTable?: string | undefined
                }
              | undefined
            ram?:
              | {
                  canvasBufferBytes?: number | undefined
                  canvasBytesPerPixel?: number | undefined
                  displayStateBytes?: number | undefined
                  height?: number | undefined
                  httpResponseLimitBytes?: number | undefined
                  packedBufferBytes?: number | undefined
                  panel?: string | undefined
                  pixelFormat?: number | undefined
                  pixelFormatName?: string | undefined
                  previewBmpBytes?: number | undefined
                  previewSnapshotBytes?: number | undefined
                  previewSnapshotReserveBytes?: number | undefined
                  psramBytes?: number | undefined
                  quickJsHeapLimitBytes?: number | undefined
                  renderMode?: 'local' | 'remote' | undefined
                  renderReserveBytes?: number | undefined
                  renderWorkingBytes?: number | undefined
                  rgbaBufferBytes?: number | undefined
                  width?: number | undefined
                }
              | undefined
          }
        | undefined
      otaElfSha256?: string | undefined
      otaPath?: string | undefined
      otaSha256?: string | undefined
      otaSize?: number | undefined
      otaSupported?: boolean | undefined
      panel?: string | undefined
      partitionTable?: string | undefined
      partitionTableSize?: number | undefined
      path?: string | undefined
      platform?: string | undefined
      queuedAt?: string | undefined
      queueJobId?: string | undefined
      requestId?: string | undefined
      sha256?: string | undefined
      size?: number | undefined
      startedAt?: string | undefined
      status?: 'building' | 'error' | 'idle' | 'missing' | 'queued' | 'ready' | 'stale' | undefined
    }
    id: FrameId
  }
  updateFrameFirmware: (id: FrameId) => {
    id: FrameId
  }
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface framesModelMeta {
  __keaTypeGenInternalSelectorTypes: {
    framesList: (frames: Record<FrameId, FrameType>) => FrameType[]
    activeFramesList: (frames: Record<FrameId, FrameType>) => FrameType[]
    archivedFramesList: (frames: Record<FrameId, FrameType>) => FrameType[]
    framesLoaded: (frames: Record<FrameId, FrameType>) => boolean
  }
}

export type framesModelType = MakeLogicType<framesModelValues, framesModelActions, Record<string, any>> &
  framesModelMeta

export const framesModel = kea<framesModelType>([
  connect(() => ({ logic: [socketLogic, entityImagesModel, longRunningTasksModel] })),
  path(['src', 'models', 'framesModel']),
  actions({
    addFrame: (frame: FrameType) => ({ frame }),
    loadFrame: (id: FrameId) => ({ id }),
    deployFrame: (id: FrameId, fastDeploy?: boolean) => ({ id, fastDeploy: fastDeploy || false }),
    cancelDeploy: (id: FrameId) => ({ id }),
    stopFrame: (id: FrameId) => ({ id }),
    restartFrame: (id: FrameId) => ({ id }),
    rebootFrame: (id: FrameId) => ({ id }),
    renderFrame: (id: FrameId) => ({ id }),
    deleteFrame: (id: FrameId) => ({ id }),
    renameFrame: (id: FrameId, name: string) => ({ id, name }),
    // Cloud only: a freshly enrolled frame is `pending` until its owner
    // confirms it, and the control plane refuses scene/settings pushes with
    // frame_not_active until then (POST /api/frames/{id}/confirm).
    confirmCloudFrame: (id: FrameId) => ({ id }),
    confirmCloudFrameFailure: (id: FrameId, error: string) => ({ id, error }),
    // Cloud only: pull the frame's store-scene assignments + scene JSON into
    // frame.scenes so the tiles survive a reload. `force` skips the
    // once-a-minute throttle (used right after an install).
    hydrateCloudFrameScenes: (id: FrameId, force?: boolean) => ({ id, force: force || false }),
    setCloudFrameScenes: (id: FrameId, scenes: FrameScene[], sources?: Record<string, CloudSceneSource>) => ({
      id,
      scenes,
      sources,
    }),
    deployRemote: (id: FrameId, recompile?: boolean, transport: RemoteTaskTransport = 'auto') => ({
      id,
      recompile: recompile || false,
      transport,
    }),
    restartRemote: (id: FrameId, transport: RemoteTaskTransport = 'auto') => ({ id, transport }),
    downloadSdCardImage: (id: FrameId) => ({ id }),
    downloadEmbeddedFirmware: (id: FrameId) => ({ id }),
    updateEmbeddedFirmwareStatus: (id: FrameId, firmware: EmbeddedFirmware) => ({ id, firmware }),
    applyEmbeddedFirmwareOta: (id: FrameId, force?: boolean) => ({ id, force: force || false }),
    // Cloud only: enqueue the advisory notify_update_available verb. The
    // device fetches the signed OTA manifest and installs on its own
    // schedule (docs/cloud-frames.md "Signed OTA") — nothing to track here.
    updateFrameFirmware: (id: FrameId) => ({ id }),
    setDeployWithAgent: (id: FrameId, deployWithAgent: boolean) => ({ id, deployWithAgent }),
    setFrameArchived: (id: FrameId, archived: boolean) => ({ id, archived }),
    toggleArchivedFramesExpanded: true,
    toggleInactiveFramesExpanded: true,
  }),
  loaders(({ values }) => ({
    frames: [
      {} as Record<FrameId, FrameType>,
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
              [frame.id]: withStoredCloudScenes(sanitizeFrameForStore(frame), values.frames[frame.id]),
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
                withStoredCloudScenes(sanitizeFrameForStore(frame), values.frames[frame.id]),
              ])
            )
            return framesDict
          } catch (error) {
            logApiError(error)
            return values.frames
          }
        },
      },
    ],
  })),
  reducers(() => ({
    // Whether the frame list has come back at least once — NOT whether it
    // contains anything. `framesLoaded` below means "has at least one frame",
    // which reads the same at a glance and is what gates the cloud workspace:
    // an account with no frames yet sat on "Loading..." forever, which is
    // exactly what a brand-new account sees. The loader swallows its own
    // errors, so success is the only outcome to listen for.
    framesEverLoaded: [
      false,
      {
        loadFramesSuccess: () => true,
      },
    ],
    // Per-frame confirm-in-flight flags and errors for the cloud's pending
    // banner. Keyed by String(id) — reducers index with the raw FrameId.
    cloudFramesConfirming: [
      {} as Record<FrameId, boolean>,
      {
        confirmCloudFrame: (state, { id }) => ({ ...state, [id]: true }),
        confirmCloudFrameFailure: (state, { id }) => ({ ...state, [id]: false }),
        loadFrameSuccess: (state) => (Object.keys(state).length > 0 ? {} : state),
      },
    ],
    cloudFrameConfirmErrors: [
      {} as Record<FrameId, string>,
      {
        confirmCloudFrame: (state, { id }) => {
          if (!(id in state)) {
            return state
          }
          const next = { ...state }
          delete next[id]
          return next
        },
        confirmCloudFrameFailure: (state, { id, error }) => ({ ...state, [id]: error }),
      },
    ],
    frames: [
      {} as Record<FrameId, FrameType>,
      {
        addFrame: (state, { frame }) => ({
          ...state,
          [frame.id]: sanitizeFrameForStore(frame),
        }),
        setCloudFrameScenes: (state, { id, scenes, sources }) => {
          const frame = state[id]
          if (!frame) return state
          return {
            ...state,
            [id]: sanitizeFrameForStore({
              ...frame,
              scenes,
              ...(sources ? { cloud_scene_sources: sources } : {}),
            }),
          }
        },
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
        updateEmbeddedFirmwareStatus: (state, { id, firmware }) => {
          const frame = state[id]
          if (!frame) return state
          const currentFirmware = frame.embedded?.firmware
          return {
            ...state,
            [id]: sanitizeFrameForStore({
              ...frame,
              embedded: {
                ...(frame.embedded ?? {}),
                firmware: mergeEmbeddedFirmwareStatus(currentFirmware, firmware),
              },
            }),
          }
        },
        [socketLogic.actionTypes.newFrame]: (state, { frame }) => ({
          ...state,
          // Cloud hub broadcasts are scene-less frameSummary rows too; keep
          // the hydrated tiles instead of blanking them until the next poll.
          [frame.id]: withStoredCloudScenes(sanitizeFrameForStore(frame), state[frame.id]),
        }),
        [socketLogic.actionTypes.updateFrame]: (state, { frame }) => ({
          ...state,
          [frame.id]: withStoredCloudScenes(
            sanitizeFrameForStore({
              ...(state[frame.id] ?? {}),
              ...frame,
              embedded:
                frame.embedded?.firmware && state[frame.id]?.embedded?.firmware
                  ? {
                      ...(state[frame.id]?.embedded ?? {}),
                      ...frame.embedded,
                      firmware: mergeEmbeddedFirmwareStatus(
                        state[frame.id]?.embedded?.firmware,
                        frame.embedded.firmware
                      ),
                    }
                  : frame.embedded ?? state[frame.id]?.embedded,
            }),
            state[frame.id]
          ),
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
    framesList: [
      (s) => [s.frames],
      (frames: framesModelValues['frames']) => sortFrames(Object.values(frames)) as FrameType[],
    ],
    activeFramesList: [
      (s) => [s.frames],
      (frames: framesModelValues['frames']) =>
        sortFrames(Object.values(frames).filter((frame) => !frame.archived)) as FrameType[],
    ],
    archivedFramesList: [
      (s) => [s.frames],
      (frames: framesModelValues['frames']) =>
        sortFrames(Object.values(frames).filter((frame) => frame.archived)) as FrameType[],
    ],
    framesLoaded: [(s) => [s.frames], (frames: framesModelValues['frames']) => Object.keys(frames).length > 0],
  }),
  afterMount(({ actions, cache }) => {
    actions.loadFrames()
    // Cloud fleets change behind the SPA's back: enrollment is an HTTP call
    // into auth-web, and the hub only broadcasts a frame once it connects its
    // WebSocket — which a pending frame flashed from an SD image may not do
    // for minutes (or, unreachable, ever). Without a refresh the list stayed
    // frozen until a manual reload. A slow, tab-visible-only poll keeps it
    // honest; the websocket still delivers the fast-path updates. Backend
    // mode keeps its pure event-sourcing — its server owns every mutation.
    if (isCloudMode() && typeof window !== 'undefined') {
      cache.cloudFleetRefreshInterval = window.setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          actions.loadFrames()
        }
      }, 15_000)
    }
  }),
  beforeUnmount(({ cache }) => {
    if (cache.cloudFleetRefreshInterval) {
      window.clearInterval(cache.cloudFleetRefreshInterval)
      cache.cloudFleetRefreshInterval = undefined
    }
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
        const frame = values.frames[id]
        let usbSucceeded = false
        if ((frame?.mode ?? 'rpios') === 'embedded' && embeddedUsbApiCanUse(id)) {
          try {
            await runEmbeddedUsbApiCommand(id, 'render', { timeoutMs: 10000 })
            usbSucceeded = true
          } catch (error) {
            // Stale/busy USB port — fall through to the HTTP event.
          }
        }
        if (!usbSucceeded) {
          // One canonical route on every control plane: the backend forwards
          // the event to the frame; the cloud's event shim maps it onto the
          // queued `render` verb.
          const response = await apiFetch(`/api/frames/${id}/event/render`, { method: 'POST' })
          if (!response.ok) {
            throw new Error('Failed to send render event')
          }
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
      // Cloud: there is no /deploy or /fast_deploy (both 404). The cloud's
      // deploy primitive is the uploadScenes event shim — one checksummed,
      // durable set_scenes push of the workspace's CURRENT scene list
      // (cloud/docs/cloud-workspace-gaps.md item 3). Fast vs full deploy is a
      // compile-time distinction that does not exist for interpreted-only
      // cloud frames, so both flags take the same path.
      if (isCloudMode()) {
        const taskId = deployTaskId(id, false)
        longRunningTasksModel.actions.startTask({
          id: taskId,
          frameId: id,
          kind: 'deploy',
          title: 'Deploying scenes',
          detail: 'Pushing scenes to the frame',
        })
        try {
          const frame = values.frames[id]
          // The edited form when the frame's workspace is open, the stored
          // scene list otherwise. framesModel cannot connect to a keyed logic,
          // hence findMounted.
          const scenes = frameLogic.findMounted({ frameId: id })?.values.frameForm?.scenes ?? frame?.scenes ?? []
          if (!scenes.length) {
            throw new Error('This frame has no scenes to deploy')
          }
          // Keep the currently active scene active; the runtime otherwise
          // activates the payload sceneId or the first scene.
          await deployCloudFrameScenes(id, scenes, {
            sceneId: cloudDeployActiveSceneId(frame?.active_scene_id, scenes),
          })
          longRunningTasksModel.actions.finishTask({
            taskId,
            frameId: id,
            kind: 'deploy',
            status: 'success',
            detail: 'Deployed — the frame applies the scenes as soon as it syncs',
          })
        } catch (error) {
          // No rethrow: deployFrame is dispatched, never awaited, so a throw
          // here is only an unhandled rejection — the task toast above is
          // the user-facing surfacing.
          longRunningTasksModel.actions.taskFailed({
            taskId,
            frameId: id,
            kind: 'deploy',
            detail: error instanceof Error ? error.message : 'Failed to deploy scenes',
          })
        }
        return
      }
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
      try {
        // Canonical on both control planes; the cloud maps it onto the
        // queued `restart_runtime` verb.
        const response = await apiFetch(`/api/frames/${id}/restart`, { method: 'POST' })
        if (!response.ok) {
          throw new Error('Failed to restart frame')
        }
      } catch (error) {
        // An embedded board that never joined Wi-Fi (or joined the wrong
        // network) has no reachable network path, but a connected USB serial
        // session can still reboot it.
        if (!(await restartEmbeddedFrameOverUsb(id, values.frames[id]))) {
          throw error
        }
      }
    },
    rebootFrame: async ({ id }) => {
      try {
        // Canonical on both control planes; the cloud maps it onto the
        // queued `reboot` verb.
        const response = await apiFetch(`/api/frames/${id}/reboot`, { method: 'POST' })
        if (!response.ok) {
          throw new Error('Failed to reboot frame')
        }
      } catch (error) {
        // On embedded frames restart and reboot are the same esp_restart().
        if (!(await restartEmbeddedFrameOverUsb(id, values.frames[id]))) {
          throw error
        }
      }
    },
    deployRemote: async ({ id, recompile, transport }) => {
      longRunningTasksModel.actions.startTask({
        frameId: id,
        kind: 'remoteDeploy',
        title: recompile ? 'Recompiling and deploying FrameOS Remote' : 'Deploying FrameOS Remote',
        detail: 'Remote deploy request sent',
      })
      try {
        const response = await apiFetch(`/api/frames/${id}/deploy_remote${remoteTaskQuery({ recompile, transport })}`, {
          method: 'POST',
        })
        if (!response.ok) {
          throw new Error('Failed to start remote deploy')
        }
      } catch (error) {
        longRunningTasksModel.actions.taskFailed({
          frameId: id,
          kind: 'remoteDeploy',
          detail: error instanceof Error ? error.message : 'Failed to deploy remote',
        })
        throw error
      }
    },
    restartRemote: async ({ id, transport }) => {
      longRunningTasksModel.actions.startTask({
        frameId: id,
        kind: 'remoteRestart',
        title: 'Restarting FrameOS Remote',
        detail: 'Remote restart request sent',
      })
      try {
        const response = await apiFetch(`/api/frames/${id}/restart_remote${remoteTaskQuery({ transport })}`, {
          method: 'POST',
        })
        if (!response.ok) {
          throw new Error('Failed to start remote restart')
        }
      } catch (error) {
        longRunningTasksModel.actions.taskFailed({
          frameId: id,
          kind: 'remoteRestart',
          detail: error instanceof Error ? error.message : 'Failed to restart remote',
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
      const currentFirmware = frame?.embedded?.firmware
      const downloadUrl = currentFirmware?.downloadUrl || `/api/frames/${id}/embedded/firmware/download`

      pendingEmbeddedFirmwareDownloads.add(id)
      embeddedFirmwareRecoveryAttempts.delete(id)
      startEmbeddedFirmwareProgress(id)
      longRunningTasksModel.actions.startTask({
        frameId: id,
        kind: 'embeddedFirmware',
        title: 'Building firmware image',
        detail:
          currentFirmware?.status === 'building' || currentFirmware?.status === 'queued'
            ? 'Checking firmware build status'
            : 'Firmware build started',
      })

      try {
        const nextFirmware = await requestEmbeddedFirmwareBuild(
          id,
          currentFirmware?.status === 'stale' || currentFirmware?.status === 'missing'
        )
        if (nextFirmware) {
          actions.updateEmbeddedFirmwareStatus(id, nextFirmware)
        }
        if (nextFirmware?.status === 'ready') {
          pendingEmbeddedFirmwareDownloads.delete(id)
          embeddedFirmwareRecoveryAttempts.delete(id)
          stopEmbeddedFirmwareProgress(id)
          startBrowserDownload(nextFirmware.downloadUrl || downloadUrl)
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
        embeddedFirmwareRecoveryAttempts.delete(id)
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
        longRunningTasksModel.actions.updateTaskProgress({
          frameId: id,
          kind: 'embeddedOta',
          progressCurrent: null,
          progressTotal: null,
          detail: 'Requesting OTA update',
        })
        const response = await apiFetch(`/api/frames/${id}/embedded/firmware/ota${force ? '?force=1' : ''}`, {
          method: 'POST',
        })
        if (!response.ok) {
          throw new Error(await responseErrorDetail(response, 'Failed to request OTA update'))
        }
        const data = await response.json()
        longRunningTasksModel.actions.finishTask({
          frameId: id,
          kind: 'embeddedOta',
          status: 'success',
          detail: data?.message || 'OTA update requested',
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
    updateFrameFirmware: async ({ id }) => {
      // The "Update firmware" menu entry, offered only for esp32 cloud
      // frames (FrameActionsMenu). One durable notify_update_available in
      // the queue; the device does the manifest fetch, signature check and
      // slot switch itself, so the toast finishes immediately — progress, if
      // any, arrives later as ota:cloud log lines.
      longRunningTasksModel.actions.startTask({
        frameId: id,
        kind: 'embeddedOta',
        title: 'Requesting firmware update',
        detail: 'Queueing the update notification',
      })
      try {
        await sendCloudFrameCommand(id, 'notify_update_available')
        longRunningTasksModel.actions.finishTask({
          frameId: id,
          kind: 'embeddedOta',
          status: 'success',
          detail: 'Update requested — the frame will check for new firmware and install it in the background',
        })
      } catch (error) {
        longRunningTasksModel.actions.taskFailed({
          frameId: id,
          kind: 'embeddedOta',
          detail: error instanceof Error ? error.message : 'Failed to request the firmware update',
        })
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
          // A build can fail within a second of starting; this broadcast then
          // races the first status poll (which bails once the pending flag is
          // gone), so the failure must be surfaced here or nothing shows it.
          longRunningTasksModel.actions.taskFailed({
            frameId: frame.id,
            kind: 'buildrootImage',
            detail: sdImage.error || 'SD card image generation failed',
          })
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
          if (firmware.status === 'missing' || firmware.status === 'stale') {
            void recoverEmbeddedFirmwareBuild(frame.id, firmware)
              .then((recovered) => {
                if (recovered) {
                  return
                }
                pendingEmbeddedFirmwareDownloads.delete(frame.id)
                embeddedFirmwareRecoveryAttempts.delete(frame.id)
                stopEmbeddedFirmwareProgress(frame.id)
                longRunningTasksModel.actions.taskFailed({
                  frameId: frame.id,
                  kind: 'embeddedFirmware',
                  detail: firmware.error || 'Firmware image needs to be rebuilt',
                })
              })
              .catch((error) => {
                pendingEmbeddedFirmwareDownloads.delete(frame.id)
                embeddedFirmwareRecoveryAttempts.delete(frame.id)
                stopEmbeddedFirmwareProgress(frame.id)
                longRunningTasksModel.actions.taskFailed({
                  frameId: frame.id,
                  kind: 'embeddedFirmware',
                  detail: error instanceof Error ? error.message : firmware.error || 'Firmware build failed',
                })
              })
          } else {
            pendingEmbeddedFirmwareDownloads.delete(frame.id)
            embeddedFirmwareRecoveryAttempts.delete(frame.id)
            stopEmbeddedFirmwareProgress(frame.id)
            longRunningTasksModel.actions.taskFailed({
              frameId: frame.id,
              kind: 'embeddedFirmware',
              detail: firmware.error || 'Firmware build failed',
            })
          }
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
      const response = await apiFetch(`/api/frames/${id}`, { method: 'DELETE' })
      if (router.values.location.pathname.includes('/frames/' + id)) {
        router.actions.push(urls.frames())
      }
      // The backend announces the deletion over its websocket (the reducer
      // listens for socketLogic.deleteFrame); the cloud has no such event, so
      // re-list to drop the row now instead of on the next 15 s poll.
      if (response.ok && isCloudMode()) {
        actions.loadFrames()
      }
    },
    confirmCloudFrame: async ({ id }) => {
      try {
        const response = await apiFetch(`/api/frames/${id}/confirm`, { method: 'POST' })
        if (!response.ok) {
          const detail = (await response.json().catch(() => ({}))) as { error?: string }
          throw new Error(detail.error ?? `error_${response.status}`)
        }
        // The row flips to active server-side; refetch so the banner drops
        // and Save/scene pushes stop being refused with frame_not_active.
        actions.loadFrame(id)
      } catch (error) {
        console.error(error)
        actions.confirmCloudFrameFailure(id, error instanceof Error ? error.message : 'Failed to confirm the frame')
      }
    },
    hydrateCloudFrameScenes: async ({ id, force }) => {
      if (!isCloudMode() || cloudFrameSceneHydrationsInFlight.has(id)) {
        return
      }
      const hydratedAt = cloudFrameScenesHydratedAt.get(id) ?? 0
      if (!force && Date.now() - hydratedAt < CLOUD_FRAME_SCENES_REFRESH_MS) {
        return
      }
      cloudFrameSceneHydrationsInFlight.add(id)
      try {
        const { scenes, sources } = await fetchCloudFrameScenes(id)
        cloudFrameScenesHydratedAt.set(id, Date.now())
        const frame = values.frames[id]
        if (!frame) {
          return
        }
        // Only dispatch real changes: every write replaces the frame object,
        // which cascades into frameLogic's `frame` subscription (frame form
        // reset) and re-renders every tile — needless churn on a poll where
        // nothing moved.
        const sanitized = scenes.map((scene) => sanitizeScene(scene, frame))
        if (
          JSON.stringify(frame.scenes ?? []) !== JSON.stringify(sanitized) ||
          JSON.stringify(frame.cloud_scene_sources ?? {}) !== JSON.stringify(sources)
        ) {
          actions.setCloudFrameScenes(id, scenes, sources)
        }
      } catch (error) {
        console.error(error)
      } finally {
        cloudFrameSceneHydrationsInFlight.delete(id)
      }
    },
    loadFrameSuccess: ({ frames }) => {
      if (isCloudMode()) {
        Object.values(frames).forEach((frame) => actions.hydrateCloudFrameScenes(frame.id))
      }
    },
    loadFramesSuccess: ({ frames }) => {
      if (isCloudMode()) {
        Object.values(frames).forEach((frame) => actions.hydrateCloudFrameScenes(frame.id))
      }
    },
    renameFrame: async ({ id, name }) => {
      try {
        // Canonical on both control planes: the backend updates the row; the
        // cloud updates frames.name and pushes set_settings {name} to
        // devices that accept it.
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
    [embeddedUsbLogsModel.actionTypes.appendUsbLog]: ({ log }) => {
      if (log.type === 'usb' && usbLogLineIndicatesImageReady(log.line)) {
        scheduleEmbeddedUsbFrameImageRefresh(log.frame_id)
      }
    },
  })),
])
