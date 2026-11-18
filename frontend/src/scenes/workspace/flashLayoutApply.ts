import type { DeepPartial } from 'kea-forms'
import { v4 as uuidv4 } from 'uuid'

import { framesModel } from '../../models/framesModel'
import type { FrameId, FrameScene, FrameType } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { scenesWithFlashLayout } from '../../utils/flashLayout'
import { frameLogic } from '../frame/frameLogic'
import { flashLayoutLogic, flashLayoutPickFor } from './flashLayoutLogic'

// Where a flash's layout choice (flashLayoutLogic) goes on a frame that
// exists: kept apart from the logic so the cloud's "Add frame" panel, which
// only mints claim codes, does not load the frame workspace's logic.

/**
 * Self-hosted backend: the frame's scenes with the chosen layout on them (the
 * same entries its Layout select saves), or null when the picker was left
 * alone. Both of the backend's flashes carry `frame.scenes`: the SD card's
 * setup file and the board's USB upload, so the caller saves these first.
 */
export function backendFlashLayoutScenes(pickerKey: string, frame: FrameType): FrameScene[] | null {
  const pick = flashLayoutPickFor(pickerKey)
  if (!pick) {
    return null
  }
  // One id for the copy, so the form below gets the same scene the frame saved.
  const id = uuidv4()
  const scenes = scenesWithFlashLayout(frame.scenes, pick, () => id)
  // The form follows (keeping its own unsaved edits), so the workspace does
  // not read the saved layout as one.
  const logic = frameLogic.findMounted({ frameId: frame.id })
  const formScenes = logic?.values.frameForm?.scenes
  if (logic && formScenes) {
    logic.actions.setFrameFormValues({
      scenes: scenesWithFlashLayout(formScenes, pick, () => id),
    } as DeepPartial<FrameType>)
  }
  return scenes
}

/**
 * Self-hosted backend, the ESP32 flash: save the frame's scenes with the
 * chosen layout (`POST /api/frames/{id}`) before the board is flashed, and
 * hand back the frame as saved for the upload over USB. The frame unchanged
 * when the picker was left alone.
 */
export async function saveBackendFlashLayout(pickerKey: string, frame: FrameType): Promise<FrameType> {
  const scenes = backendFlashLayoutScenes(pickerKey, frame)
  if (!scenes) {
    return frame
  }
  const response = await apiFetch(`/api/frames/${frame.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenes }),
  })
  if (!response.ok) {
    let detail = ''
    try {
      detail = String((await response.json())?.detail ?? '')
    } catch {
      detail = ''
    }
    throw new Error(detail || 'Could not save the layout on the frame')
  }
  framesModel.findMounted()?.actions.loadFrame(frame.id)
  return { ...frame, scenes }
}

/**
 * FrameOS Cloud, a frame that exists ("Write another SD card", "Redeploy to
 * this board"): the layout goes into the frame's form and the form is saved,
 * exactly as its Settings' Layout select and Save do, so the scenes are
 * pushed with it and reach the board once it is back. Nothing when the
 * picker was left alone.
 */
export async function saveFrameFlashLayout(pickerKey: string, frameId: FrameId): Promise<void> {
  const pick = flashLayoutPickFor(pickerKey)
  if (!pick) {
    return
  }
  const logic = frameLogic({ frameId })
  const unmount = logic.mount()
  try {
    const form = logic.values.frameForm
    const current = form?.scenes ?? logic.values.frame?.scenes ?? []
    logic.actions.setFrameFormValues({
      scenes: scenesWithFlashLayout(current, pick, uuidv4),
    } as DeepPartial<FrameType>)
    await logic.asyncActions.submitFrameForm()
  } finally {
    unmount()
  }
}

/**
 * Self-hosted backend, a flow whose flash the browser does not run (a Pico's
 * .uf2 is copied by hand): save the layout when the firmware is fetched, and
 * say under the select when that failed.
 */
export function saveBackendFlashLayoutInBackground(pickerKey: string, frame: FrameType): void {
  const logic = flashLayoutLogic.findMounted({ pickerKey })
  logic?.actions.setError(null)
  saveBackendFlashLayout(pickerKey, frame).catch((error) => {
    logic?.actions.setError(error instanceof Error ? error.message : String(error))
  })
}
