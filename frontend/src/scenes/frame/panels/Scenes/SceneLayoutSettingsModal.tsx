import { useActions, useValues } from 'kea'
import type { FormEvent } from 'react'

import { Modal } from '../../../../components/Modal'
import type { FrameId, StateField } from '../../../../types'
import { sceneLayoutLogic } from './sceneLayoutLogic'
import { StateFieldEdit } from './StateFieldEdit'

/** The chosen layout's public fields, for this install ("Layout settings" in the scene menu). */
export function SceneLayoutSettingsModal({
  frameId,
  sceneId,
}: {
  frameId: FrameId
  sceneId: string
}): JSX.Element | null {
  const logic = sceneLayoutLogic({ frameId, sceneId })
  const { settingsOpen, settingsForEveryScene, currentLayoutScene, fields, draftState } = useValues(logic)
  const { closeLayoutSettings, setStateValue, saveLayoutSettings } = useActions(logic)
  if (!settingsOpen || !currentLayoutScene) {
    return null
  }
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    saveLayoutSettings()
  }
  return (
    <Modal open onClose={closeLayoutSettings} title={`Layout settings: ${currentLayoutScene.name}`}>
      <form onSubmit={handleSubmit} className="space-y-4 p-5">
        {fields.length === 0 ? (
          <p className="frameos-muted text-sm">This layout has no settings to change.</p>
        ) : (
          <div className="space-y-3">
            {(fields as StateField[]).map((field) => (
              <div key={field.name} className="space-y-1">
                <label className="frameos-muted text-sm font-semibold">{field.label || field.name}</label>
                <StateFieldEdit
                  field={field}
                  value={draftState[field.name] ?? field.value ?? ''}
                  onChange={(value) => setStateValue(field, value)}
                  currentState={{}}
                  stateChanges={draftState}
                  frameId={frameId}
                />
              </div>
            ))}
          </div>
        )}
        <p className="frameos-muted text-xs">
          {settingsForEveryScene
            ? 'These go on every scene wearing this layout.'
            : 'These belong to this installed scene: other scenes wearing the layout keep their own.'}{' '}
          Save the frame to push
          them.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={closeLayoutSettings}
            className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="frameos-primary-action rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Apply
          </button>
        </div>
      </form>
    </Modal>
  )
}
