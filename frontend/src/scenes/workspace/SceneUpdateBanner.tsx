import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { ArrowUpCircleIcon } from '@heroicons/react/24/solid'

import { Spinner } from '../../components/Spinner'
import { sceneUpdatesLogic } from '../frame/panels/Scenes/sceneUpdatesLogic'
import { shortSceneVersion } from '../../utils/sceneOrigin'
import type { FrameId } from '../../types'

/**
 * "Update", laid over a scene's image: shown while the scene's source (the
 * FrameOS Cloud store, a private cloud scene, any repository) has a newer
 * version than the one installed on this frame. Clicking it asks, then
 * updates — the same action as "Update to latest" in the scene menu. While
 * the update runs (from either entry point) it spins and says "Updating…",
 * and only goes away once the workspace shows the new version. Renders
 * nothing when the scene is current, so callers mount it unconditionally.
 *
 * sceneUpdatesLogic and not scenesLogic: this renders on the frames home, and
 * scenesLogic would mount controlLogic, which fetches frame state.
 */
export function SceneUpdateBanner({
  frameId,
  sceneId,
  size = 'normal',
  className,
}: {
  frameId: FrameId
  sceneId: string
  /** `small` fits a 144px scene tile. */
  size?: 'small' | 'normal'
  className?: string
}): JSX.Element | null {
  const { sceneUpdateVersions, updatingSceneIds } = useValues(sceneUpdatesLogic({ frameId }))
  const { confirmSceneUpdate } = useActions(sceneUpdatesLogic({ frameId }))
  const version = sceneUpdateVersions[sceneId]
  const updating = Boolean(updatingSceneIds[sceneId])
  if (!version && !updating) {
    return null
  }
  const iconClassName = size === 'small' ? 'h-3.5 w-3.5' : 'h-4 w-4'
  return (
    <button
      type="button"
      data-scene-update-banner={sceneId}
      disabled={updating}
      aria-busy={updating}
      title={
        updating
          ? 'Updating this scene to the latest version'
          : `Version ${shortSceneVersion(version)} of this scene is available — click to update`
      }
      onClick={(event) => {
        event.stopPropagation()
        confirmSceneUpdate(sceneId)
      }}
      className={clsx(
        'pointer-events-auto flex items-center rounded-full border border-sky-500/45 bg-white/95 font-semibold text-sky-700 shadow-sm backdrop-blur-sm transition hover:bg-sky-50 hover:text-sky-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
        size === 'small' ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-1.5 px-2.5 py-1 text-xs',
        updating && 'cursor-progress',
        className
      )}
    >
      {updating ? (
        <Spinner className={clsx(iconClassName, '[&>svg]:h-full [&>svg]:w-full')} />
      ) : (
        <ArrowUpCircleIcon className={iconClassName} />
      )}
      <span>{updating ? 'Updating…' : 'Update'}</span>
    </button>
  )
}
