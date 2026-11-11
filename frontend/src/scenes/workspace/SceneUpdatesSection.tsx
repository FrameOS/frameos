import clsx from 'clsx'
import { useActions, useValues } from 'kea'
import { Fragment } from 'react'

import { Checkbox } from '../../components/Checkbox'
import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/Spinner'
import type { FrameType } from '../../types'
import { isCloudMode } from '../../utils/cloudMode'
import type { SceneFileDiff } from '../../utils/sceneDiff'
import { shortSceneVersion } from '../../utils/sceneOrigin'
import { sceneUpdatesLogic, type PendingSceneUpdate } from '../frame/panels/Scenes/sceneUpdatesLogic'

function versionLabel(update: PendingSceneUpdate): string {
  if (isCloudMode()) {
    return update.fromVersion ? `v${update.fromVersion} → v${update.toVersion}` : `v${update.toVersion}`
  }
  const to = shortSceneVersion(update.toVersion)
  return update.fromVersion ? `${shortSceneVersion(update.fromVersion)} → ${to}` : to
}

function FileDiff({ file }: { file: SceneFileDiff }): JSX.Element {
  return (
    <div className="frameos-divider overflow-hidden rounded-xl border border-slate-200/80">
      <div className="frameos-divider flex items-center justify-between gap-3 border-b border-slate-200/80 bg-slate-500/5 px-3 py-1.5 text-xs">
        <span className="min-w-0 truncate font-mono font-semibold">{file.path}</span>
        <span className="shrink-0 font-mono">
          {file.status !== 'changed' ? <span className="frameos-muted mr-2">{file.status}</span> : null}
          <span className="text-emerald-600">+{file.added}</span> <span className="text-rose-600">−{file.removed}</span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {file.hunks.map((hunk, hunkIndex) => (
              <Fragment key={hunkIndex}>
                <tr className="frameos-muted bg-slate-500/10">
                  <td colSpan={3} className="px-3">
                    @@ −{hunk.oldStart} +{hunk.newStart} @@
                  </td>
                </tr>
                {hunk.lines.map((line, lineIndex) => (
                  <tr
                    key={lineIndex}
                    className={clsx(
                      line.kind === 'add' && 'bg-emerald-500/15',
                      line.kind === 'remove' && 'bg-rose-500/15'
                    )}
                  >
                    <td className="frameos-muted w-10 select-none px-2 text-right align-top">
                      {line.kind !== 'add' ? line.oldLine : ''}
                    </td>
                    <td className="frameos-muted w-10 select-none px-2 text-right align-top">
                      {line.kind !== 'remove' ? line.newLine : ''}
                    </td>
                    <td className="whitespace-pre px-2">
                      <span className="select-none">
                        {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                      </span>
                      {line.text}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * The deploy drawer's "Scene updates", both control planes: the installed
 * scenes with a newer version, which a deploy from the drawer updates
 * (sceneUpdatesLogic.deployWithSceneUpdates). Untick one to keep the version
 * the frame has; click one to see what changes, its code file by file.
 */
export function SceneUpdatesSection({
  frame,
  className,
}: {
  frame: FrameType
  className?: string
}): JSX.Element | null {
  const logic = sceneUpdatesLogic({ frameId: frame.id })
  const { pendingSceneUpdates, skippedSceneUpdateKeys, sceneUpdateDiff } = useValues(logic)
  const { toggleSceneUpdateSkipped, openSceneUpdateDiff, closeSceneUpdateDiff } = useActions(logic)
  if (pendingSceneUpdates.length === 0) {
    return null
  }
  const openUpdate = sceneUpdateDiff
    ? pendingSceneUpdates.find((update) => update.key === sceneUpdateDiff.key) ?? null
    : null
  return (
    <section className={clsx('space-y-2', className)}>
      <div className="frame-tool-heading text-sm font-semibold">Scene updates</div>
      <div className="frame-tool-card space-y-3 rounded-[22px] p-4">
        <div className="frame-tool-muted text-sm leading-5">
          {isCloudMode()
            ? 'These scenes have a newer version. Deploying updates the ticked ones.'
            : 'These scenes have a newer version in their repository. Deploying updates the ticked ones. Field values are kept, other edits to them are replaced.'}{' '}
          Click a scene to see what changes.
        </div>
        <ul className="space-y-1.5" data-testid="scene-updates">
          {pendingSceneUpdates.map((update) => (
            <li key={update.key} className="flex items-center gap-2">
              <Checkbox
                aria-label={`Update ${update.name}`}
                value={!skippedSceneUpdateKeys[update.key]}
                onChange={() => toggleSceneUpdateSkipped(update.key)}
              />
              <button
                type="button"
                onClick={() => openSceneUpdateDiff(update.key)}
                title="See what changes"
                className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-[color:var(--tool-strong)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                {update.name}
                {update.sceneIds.length > 1 ? (
                  <span className="frame-tool-muted font-normal"> ({update.sceneIds.length} scenes)</span>
                ) : null}
              </button>
              <span className="frame-tool-muted shrink-0 font-mono text-xs">{versionLabel(update)}</span>
            </li>
          ))}
        </ul>
      </div>
      {sceneUpdateDiff ? (
        <Modal
          open
          onClose={closeSceneUpdateDiff}
          title={`Changes in ${openUpdate?.name ?? 'scene'}${openUpdate ? `, ${versionLabel(openUpdate)}` : ''}`}
          panelClassName="max-w-[1100px]"
          fullHeight
        >
          <div className="space-y-3 p-5" data-testid="scene-update-diff">
            {sceneUpdateDiff.loading ? (
              <div className="frameos-muted flex items-center gap-2 text-sm">
                <Spinner /> Loading the newer version
              </div>
            ) : sceneUpdateDiff.error ? (
              <div className="text-sm font-semibold text-red-500">{sceneUpdateDiff.error}</div>
            ) : sceneUpdateDiff.files && sceneUpdateDiff.files.length > 0 ? (
              sceneUpdateDiff.files.map((file) => <FileDiff key={file.path} file={file} />)
            ) : (
              <div className="frameos-muted text-sm">Nothing in the scene changes, only its version.</div>
            )}
          </div>
        </Modal>
      ) : null}
    </section>
  )
}
