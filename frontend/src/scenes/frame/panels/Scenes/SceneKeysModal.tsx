import { useActions, useValues } from 'kea'
import type { FormEvent } from 'react'

import { Modal } from '../../../../components/Modal'
import { Select } from '../../../../components/Select'
import type { FrameId } from '../../../../types'
import { urls } from '../../../../urls'
import { KEY_REFUSED, sceneKeysLogic } from './sceneKeysLogic'

/**
 * "Keys" for one installed scene: one row per service its apps declare, each
 * with the key it gets — the default, a named key (Settings → Service keys),
 * or none. Saving writes the install's `keys` into the frame form; the
 * frame's own Save pushes it (docs/service-keys.md).
 */
export function SceneKeysModal({ frameId, sceneId }: { frameId: FrameId; sceneId: string }): JSX.Element | null {
  const logic = sceneKeysLogic({ frameId, sceneId })
  const { isOpen, scene, rows, choices, changed } = useValues(logic)
  const { closeSceneKeys, setKeyChoice, saveSceneKeys } = useActions(logic)

  if (!isOpen || !scene) {
    return null
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (changed) {
      saveSceneKeys()
    }
  }

  return (
    <Modal open onClose={closeSceneKeys} title={`Keys: ${scene.name}`}>
      <form onSubmit={handleSubmit} className="space-y-4 p-5">
        {rows.length === 0 ? (
          <p className="frameos-muted text-sm">This scene&apos;s apps use no service key.</p>
        ) : (
          <>
            <p className="frameos-muted text-sm">
              Which of your keys this scene gets for each service its apps use. Named keys are added under{' '}
              <a className="frameos-link hover:underline" href={`${urls.settings()}#settings-service-keys`}>
                Settings → Service keys
              </a>
              .
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="frameos-muted text-left text-xs uppercase tracking-wide">
                  <th className="py-1 pr-3 font-semibold">Service</th>
                  <th className="py-1 font-semibold">Key</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.service}>
                    <td className="py-1 pr-3 align-middle font-medium">
                      {row.title}
                      {row.defaultMissing && choices[row.service] === 'default' ? (
                        <div className="frameos-muted text-xs font-normal">The default key is not set yet.</div>
                      ) : null}
                    </td>
                    <td className="py-1">
                      <Select
                        value={choices[row.service] ?? KEY_REFUSED}
                        onChange={(value) => setKeyChoice(row.service, value === KEY_REFUSED ? null : value)}
                        options={row.options}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="frameos-muted text-xs">
              The choice belongs to this installed scene, not to the scene itself: updating the scene keeps it. Save the
              frame to push it.
            </p>
          </>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={closeSceneKeys}
            className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Cancel
          </button>
          {rows.length > 0 ? (
            <button
              type="submit"
              disabled={!changed}
              className="frameos-primary-action rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Apply
            </button>
          ) : null}
        </div>
      </form>
    </Modal>
  )
}

/**
 * The same choices inline, written into the frame form as they change: one
 * select per service the scene's apps declare (the store scenes' list in
 * the frame's settings).
 */
export function SceneKeySelects({ frameId, sceneId }: { frameId: FrameId; sceneId: string }): JSX.Element | null {
  const logic = sceneKeysLogic({ frameId, sceneId })
  const { rows, current } = useValues(logic)
  const { setSceneKey } = useActions(logic)
  if (rows.length === 0) {
    return null
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {rows.map((row) => (
        <label key={row.service} className="inline-flex items-center gap-1 text-xs">
          <span>{row.title}</span>
          <Select
            value={current[row.service] ?? KEY_REFUSED}
            onChange={(value) => setSceneKey(row.service, value === KEY_REFUSED ? null : value)}
            options={row.options}
          />
        </label>
      ))}
    </div>
  )
}
