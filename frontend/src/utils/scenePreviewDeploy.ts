import type { WorkspaceMode } from '../scenes/workspace/workspaceSurfaces'

/**
 * What "Deploy to frame" does, and what the preview surface says it is
 * showing. Pure module (no kea, no React, no DOM): the shared-spa tests
 * import it directly, and both the drawer's button and its tooltip read the
 * same rule from here.
 */

/**
 * - `uploadScenes`          send the whole edited scene JSON and show it
 * - `saveThenUploadScenes`  save the frame first (on the device, save is cheap
 *                           and "preview" IS activate), then send it
 * - `cloudDeployScenes`     the cloud's one durable push: the same scene JSON,
 *                           carrying the frame's other scenes so the push does
 *                           not leave the frame holding this one alone
 * - `activate`              make this the active scene, with the state fields
 * - `apply`                 same call, on the scene that is already active
 */
export type SceneDeployPath = 'uploadScenes' | 'saveThenUploadScenes' | 'cloudDeployScenes' | 'activate' | 'apply'

export interface SceneDeployChoice {
  path: SceneDeployPath
  /** Tooltip for the button — the mechanism never goes into the label. */
  description: string
}

export interface ChooseSceneDeployPathInput {
  mode: WorkspaceMode
  /** The scene has unsaved or undeployed edits. */
  sceneHasChanges: boolean
  /** The frame is already showing this scene. */
  isActiveScene: boolean
}

/**
 * One button, five paths. With edits pending we send the scene itself so the
 * user sees exactly what is on screen in the editor; with nothing pending we
 * activate by id and carry the state fields along.
 */
export function chooseSceneDeployPath({
  mode,
  sceneHasChanges,
  isActiveScene,
}: ChooseSceneDeployPathInput): SceneDeployChoice {
  if (sceneHasChanges) {
    // On the device the scene lives on the frame itself: there is no separate
    // deploy, so saving it first is both possible and what the user means.
    if (mode === 'frameAdmin') {
      return { path: 'saveThenUploadScenes', description: 'Saves the scene on the frame and shows it' }
    }
    // The cloud has no scene "save" and one durable push, which REPLACES the
    // frame's scene list — so this one carries the frame's other scenes along
    // instead of leaving the frame holding the previewed scene alone. It is
    // the same action the drawer's change notice offers under the same name.
    if (mode === 'cloud') {
      return { path: 'cloudDeployScenes', description: 'Deploys this scene to the frame and shows it' }
    }
    return {
      path: 'uploadScenes',
      description: 'Sends the edited scene to the frame and shows it, without saving or deploying',
    }
  }
  return isActiveScene
    ? { path: 'apply', description: 'Re-sends the state fields to the active scene' }
    : { path: 'activate', description: 'Makes this the active scene on the frame' }
}

/** Which image (or canvas) the drawer's preview surface is showing. */
export type ScenePreviewSurface = 'live' | 'pending' | 'frame' | 'snapshot'

export interface ScenePreviewStatusInput {
  surface: ScenePreviewSurface
  /** livePreviewLogic.previewStatus, while the surface is 'live'. */
  previewStatus?: 'loading' | 'running' | 'error' | null
  previewError?: string | null
  renderWidth?: number | null
  renderHeight?: number | null
  lastRenderMs?: number | null
  measuredFps?: number | null
  /** The real-time (unthrottled) render mode is on. */
  fastMode?: boolean
  runtimeVersion?: string | null
  /** The frame has a stored snapshot of this scene. */
  hasSnapshot?: boolean
  /** Why the last deploy did not settle cleanly, if it did not. */
  deployNotice?: string | null
}

export interface ScenePreviewStatus {
  left: string
  right: string
  /** Render `left` in red. */
  error: boolean
}

/** "24" / "7.5": whole numbers from 10 up, one decimal below. */
export function formatFps(fps: number): string {
  return fps >= 10 ? Math.round(fps).toString() : fps.toFixed(1).replace(/\.0$/, '')
}

/** "every 42 ms (about 24 times a second)" for the fast-render prompt. */
export function describeRenderRate(intervalMs: number): string {
  const ms = Math.max(1, Math.round(intervalMs))
  return `every ${ms} ms (about ${formatFps(1000 / ms)} times a second)`
}

/** The one-line status under the preview surface (left text, right text). */
export function livePreviewStatusText({
  surface,
  previewStatus = null,
  previewError = null,
  renderWidth = null,
  renderHeight = null,
  lastRenderMs = null,
  measuredFps = null,
  fastMode = false,
  runtimeVersion = null,
  hasSnapshot = true,
  deployNotice = null,
}: ScenePreviewStatusInput): ScenePreviewStatus {
  const runtime = runtimeVersion ? `runtime ${runtimeVersion}` : ''

  if (surface === 'live') {
    if (previewStatus === 'error') {
      return { left: previewError || 'The browser preview failed', right: runtime, error: true }
    }
    if (lastRenderMs === null || renderWidth === null || renderHeight === null) {
      return { left: 'Rendering scene in your browser…', right: runtime, error: false }
    }
    const rate = fastMode && measuredFps !== null ? ` · ${formatFps(measuredFps)} fps` : ''
    return {
      left: `Rendered ${renderWidth}×${renderHeight} in ${lastRenderMs} ms${rate}`,
      right: runtime,
      error: false,
    }
  }

  if (surface === 'pending') {
    return { left: 'Waiting for the frame to render…', right: '', error: false }
  }

  if (surface === 'frame') {
    return deployNotice
      ? { left: deployNotice, right: '', error: true }
      : { left: 'Rendered on the frame', right: '', error: false }
  }

  return hasSnapshot
    ? { left: 'Scene snapshot', right: '', error: false }
    : { left: 'No snapshot yet', right: '', error: false }
}
