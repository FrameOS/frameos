import { useActions, useValues } from 'kea'
import clsx from 'clsx'

import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/Spinner'
import { frameHost } from '../../decorators/frame'
import { urls } from '../../urls'
import { frameIdsEqual } from '../../utils/frameId'
import { installSceneLogic } from './installSceneLogic'

// The dialog behind a tile's Install button: pick one or more frames, then
// install. Mounted once per library page.
export function InstallSceneModal(): JSX.Element | null {
  const { target, selectedFrameIds, installing, frameGroups, installableFrames } = useValues(installSceneLogic)
  const { closeInstall, toggleFrame, install } = useActions(installSceneLogic)
  if (!target) {
    return null
  }
  const selected = (id: (typeof installableFrames)[number]['id']) =>
    selectedFrameIds.some((candidate) => frameIdsEqual(candidate, id))
  return (
    <Modal
      open
      onClose={closeInstall}
      title={`Install "${target.template.name}"`}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={closeInstall}
            className="frameos-form-control h-10 rounded-xl border px-4 text-sm font-semibold transition hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={install}
            disabled={installing || selectedFrameIds.length === 0}
            className="frameos-primary-action flex h-10 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            {installing ? <Spinner className="h-4 w-4" color="white" /> : null}
            {selectedFrameIds.length > 1 ? `Install on ${selectedFrameIds.length} frames` : 'Install'}
          </button>
        </div>
      }
    >
      {installableFrames.length === 0 ? (
        <p className="frameos-muted text-sm">
          No frames to install on yet.{' '}
          <a href={urls.frames()} className="font-semibold underline-offset-2 hover:underline">
            Add a frame
          </a>{' '}
          first.
        </p>
      ) : (
        <div className="space-y-4">
          <p className="frameos-muted text-sm">Choose the frames this scene should be installed on.</p>
          {frameGroups.map((group) => (
            <div key={group.key}>
              <div className="frameos-muted mb-1 text-xs font-semibold uppercase tracking-wide">{group.label}</div>
              <div className="space-y-1">
                {group.frames.map((frame) => (
                  <label
                    key={frame.id}
                    className={clsx(
                      'frameos-settings-nav-link flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm transition hover:bg-slate-100',
                      selected(frame.id) && 'frameos-settings-nav-link-active'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selected(frame.id)}
                      onChange={() => toggleFrame(frame.id)}
                      className="h-4 w-4"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">{frame.name || frameHost(frame)}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
