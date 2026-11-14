import clsx from 'clsx'
import { useActions, useValues } from 'kea'
import { PlayIcon } from '@heroicons/react/24/solid'

import { Tag } from '../../components/Tag'
import type { FrameType, ScenePreviewInfo } from '../../types'
import { scenesLogic } from '../frame/panels/Scenes/scenesLogic'

// A scene the frame shows for now without holding it in its list (the
// editor's "Preview on frame", the voice chat's picture): drawn above the
// frame's scenes as a row of its own, since no saved scene is it, with
// Install and Discard (docs/scene-previews.md).
//
// Only a frame with a preview mounts scenesLogic: the frames home draws this
// for every frame, and scenesLogic brings controlLogic and its /states fetch.
export function ScenePreviewRow({ frame }: { frame: FrameType }): JSX.Element | null {
  const scenePreview = frame.scene_preview ?? null
  return scenePreview ? <StandingScenePreviewRow frame={frame} scenePreview={scenePreview} /> : null
}

function StandingScenePreviewRow({
  frame,
  scenePreview,
}: {
  frame: FrameType
  scenePreview: ScenePreviewInfo
}): JSX.Element {
  const { linkedActiveSceneId } = useValues(scenesLogic({ frameId: frame.id }))
  const { discardPreview, installPreviewScene } = useActions(scenesLogic({ frameId: frame.id }))
  const previewActive = !!scenePreview.scene_id && scenePreview.scene_id === linkedActiveSceneId

  return (
    <div
      className="frameos-frame-row mb-3 flex min-w-0 max-w-xl items-center gap-2 rounded-xl border border-dashed border-amber-300/80 px-3 py-2 text-slate-700"
      title={
        scenePreview.source === 'voice'
          ? 'A picture the voice chat put on the frame for now. It is not in the scene list, and stays on the frame until it is installed or discarded.'
          : scenePreview.source === 'panel'
          ? 'A store scene previewed from the Scene store on the frame. It is not in the scene list, and stays on the frame until it is installed or discarded.'
          : 'A scene previewed on the frame for now. It is not in the scene list, and stays on the frame until it is installed or discarded.'
      }
      data-testid="scene-preview-row"
    >
      <span className="frameos-card-media relative flex h-10 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/70 bg-amber-50 shadow-sm">
        <PlayIcon className="h-5 w-5 text-amber-500" />
        <span
          title={previewActive ? 'Active scene' : 'Inactive scene'}
          aria-label={previewActive ? 'Active scene' : 'Inactive scene'}
          className={clsx(
            'absolute bottom-1 right-1 h-2.5 w-2.5 rounded-full shadow-sm ring-2',
            previewActive ? 'bg-emerald-500 ring-white' : 'bg-white ring-slate-300/80'
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="frameos-strong block truncate text-sm font-semibold text-slate-700">
          {scenePreview.name || 'Preview'}
        </span>
        <span className="frameos-muted mt-0.5 block truncate text-xs text-slate-400">
          {scenePreview.source === 'voice'
            ? 'from the voice chat'
            : scenePreview.source === 'panel'
            ? "from the frame's Scene store"
            : 'from the editor'}{' '}
          · not in the list
        </span>
      </span>
      <Tag
        color="yellow"
        title="Shown for now, not saved"
        className="shrink-0 px-1.5 py-0 text-[10px] font-semibold normal-case"
      >
        preview
      </Tag>
      {scenePreview.scene_id ? (
        <button
          type="button"
          onClick={() => installPreviewScene()}
          title="Add the previewed scene to the frame's scene list and push it, so it stays."
          className="frameos-secondary-button shrink-0 rounded-lg px-2 py-1 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          Install
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => discardPreview()}
        title="Take the preview off the frame: it goes back to its saved scenes. Asks first."
        className="frameos-secondary-button shrink-0 rounded-lg px-2 py-1 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        Discard
      </button>
    </div>
  )
}
