import { useActions, useValues } from 'kea'
import type { FormEvent } from 'react'

import { Modal } from '../../../../components/Modal'
import { TextInput } from '../../../../components/TextInput'
import { scenesLogic } from './scenesLogic'

export function RenameSceneModal({ frameId }: { frameId: number }): JSX.Element | null {
  const { renameSceneDialog, scenes } = useValues(scenesLogic({ frameId }))
  const { closeRenameSceneDialog, setRenameSceneName, submitRenameScene } = useActions(scenesLogic({ frameId }))

  if (!renameSceneDialog) {
    return null
  }

  const scene = scenes.find((candidate) => candidate.id === renameSceneDialog.sceneId)
  const currentName = scene?.name ?? ''
  const nextName = renameSceneDialog.name.trim()
  const canSave = nextName.length > 0 && nextName !== currentName

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!canSave) {
      return
    }
    submitRenameScene()
  }

  return (
    <Modal open onClose={closeRenameSceneDialog} title="Rename scene">
      <form onSubmit={handleSubmit} className="space-y-4 p-5">
        <label className="block">
          <span className="frameos-muted mb-2 block text-sm font-semibold">Scene name</span>
          <TextInput autoFocus value={renameSceneDialog.name} onChange={setRenameSceneName} />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={closeRenameSceneDialog}
            className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="frameos-primary-action rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Rename
          </button>
        </div>
      </form>
    </Modal>
  )
}
