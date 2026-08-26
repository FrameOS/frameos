import type { FrameId } from './frameId'
import { apiFetch } from './apiFetch'
import { isCloudMode } from './cloudMode'
import { entityImagesModel } from '../models/entityImagesModel'
import { longRunningTasksModel } from '../models/longRunningTasksModel'

/** Where a newly added scene's cover should be copied from.
 *
 * Everything except `blob` is resolved by the backend: the browser must not
 * fetch third-party image bytes to re-upload them, and for the FrameOS Cloud
 * store it cannot — the store serves scene covers without an
 * `access-control-allow-origin` header, so `<img src>` renders them but
 * `fetch()` is blocked by CORS. That is why every install from the store used
 * to leave its tile stuck on "no snapshot".
 */
export type SceneImageSource =
  /** Bytes we already hold (a split-screen render, an upload). */
  | { blob: Blob }
  /** A locally saved template's cover. */
  | { templateId: string }
  /** A repository template's cover URL — same-origin path or absolute URL. */
  | { url: string }
  /** Another scene's stored snapshot on this (or another) frame. */
  | { sourceSceneId: string; sourceFrameId?: FrameId }

function copyRequestBody(source: SceneImageSource): Record<string, unknown> | null {
  if ('blob' in source) {
    return null
  }
  if ('templateId' in source) {
    return { template_id: source.templateId }
  }
  if ('url' in source) {
    return { url: source.url }
  }
  return {
    source_scene_id: source.sourceSceneId,
    ...(source.sourceFrameId !== undefined ? { source_frame_id: source.sourceFrameId } : {}),
  }
}

export class SceneImageError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'SceneImageError'
    this.status = status
  }
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const payload = await response.json()
    if (payload?.detail) {
      return String(payload.detail)
    }
  } catch {
    // fall through to the status code
  }
  return `unexpected status ${response.status}`
}

/** Give one scene a cover image. Throws a SceneImageError on failure. */
export async function assignSceneImage(frameId: FrameId, sceneId: string, source: SceneImageSource): Promise<void> {
  const body = copyRequestBody(source)
  const response = body
    ? await apiFetch(`/api/frames/${frameId}/scene_images/${sceneId}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    : await apiFetch(`/api/frames/${frameId}/scene_images/${sceneId}`, {
        method: 'POST',
        body: (source as { blob: Blob }).blob,
      })
  if (!response.ok) {
    throw new SceneImageError(await errorDetail(response), response.status)
  }
  entityImagesModel.actions.updateEntityImage(`frames/${frameId}`, `scene_images/${sceneId}`)
}

/** Tell the user a cover could not be copied.
 *
 * A cover that never arrives is indistinguishable from a scene that has not
 * rendered yet — both show "no snapshot" forever — so this must not be left
 * to a console.error nobody reads.
 */
export function reportSceneImageFailure(frameId: FrameId, sceneId: string, label: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  console.error(`Failed to copy the scene ${label}`, error)
  longRunningTasksModel.actions.startTask({
    frameId,
    kind: 'sceneImage',
    title: `Copying the scene ${label}`,
    detail: null,
    sceneId,
  })
  longRunningTasksModel.actions.taskFailed({
    frameId,
    kind: 'sceneImage',
    sceneId,
    detail: `${detail}. The scene tile stays blank until the frame renders it.`,
  })
}

export interface AssignSceneImagesOptions {
  /** Named in the failure toast, e.g. "cover image". */
  label?: string
  /** Treat "the source has no image either" (404) as a normal outcome. */
  ignoreMissingSource?: boolean
}

/** Give several new scenes the same cover, reporting failures to the user. */
export async function assignSceneImages(
  frameId: FrameId,
  sceneIds: string[],
  source: SceneImageSource | null,
  options: AssignSceneImagesOptions = {}
): Promise<void> {
  const label = options.label ?? 'preview image'
  if (!sceneIds.length || !source) {
    return
  }
  // On the cloud control plane the scene tiles are served from the store
  // scene the assignment installed, so copying a cover from a template or
  // another scene is neither possible nor needed. Bytes we already hold (a
  // zip's cover, a split-screen render) are the exception: the cloud's
  // scene_images route writes them into the frame's snapshot cache, which is
  // where the tile looks first.
  if (isCloudMode() && !('blob' in source)) {
    return
  }

  try {
    await Promise.all(sceneIds.map((sceneId) => assignSceneImage(frameId, sceneId, source)))
  } catch (error) {
    if (options.ignoreMissingSource && error instanceof SceneImageError && error.status === 404) {
      // The scene we copied from has no snapshot yet either — nothing to
      // report, the new tile is blank for the same honest reason.
      return
    }
    reportSceneImageFailure(frameId, sceneIds[0], label, error)
  }
}
