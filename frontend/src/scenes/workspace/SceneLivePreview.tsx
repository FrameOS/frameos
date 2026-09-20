import { useActions, useValues } from 'kea'
import { A } from 'kea-router'
import clsx from 'clsx'

import { FrameImage, FrameImageRefreshButton } from '../../components/FrameImage'
import type { FrameType } from '../../types'
import { urls } from '../../urls'
import { publicSceneId } from '../../utils/systemScenes'
import { FrameLiveBadge } from './FrameLiveBadge'
import { sceneLivePreviewLogic } from './sceneLivePreviewLogic'

function frameAspectRatio(frame: FrameType): number | undefined {
  if (!frame.width || !frame.height) {
    return undefined
  }
  return frame.rotate === 90 || frame.rotate === 270 ? frame.height / frame.width : frame.width / frame.height
}

/**
 * What the frame is showing right now, on top of the scene editor's Preview
 * panel. It is the FRAME's picture, not this scene's: when another scene is
 * live the picture is dimmed under a notice, so nobody reads a stranger's
 * render as the result of the fields below.
 */
export function SceneLivePreview({ frame, sceneId }: { frame: FrameType; sceneId: string }): JSX.Element {
  const logic = sceneLivePreviewLogic({ frameId: frame.id, sceneId })
  const { liveSceneId, liveSceneName, otherSceneObscured } = useValues(logic)
  const { showLiveSceneAnyway } = useActions(logic)
  // Only a scene the frame row knows can be rendered in the browser instead.
  const liveScene = frame.scenes?.find((scene) => scene.id === publicSceneId(liveSceneId))

  return (
    <div
      data-testid="scene-live-preview"
      className="frameos-card relative overflow-hidden rounded-2xl border border-white/80 bg-white/65 shadow-sm"
    >
      <A
        href={urls.frame(frame.id, 'preview')}
        className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <div
          className="frameos-card-media relative mx-auto max-h-64 w-full bg-slate-100"
          style={{ aspectRatio: frameAspectRatio(frame) ?? 16 / 9 }}
        >
          <FrameImage
            frameId={frame.id}
            refreshable={false}
            objectFit="contain"
            className={clsx('h-full w-full transition-opacity', otherSceneObscured && 'opacity-50')}
            wasmFallback={liveScene ? { sceneId: liveScene.id } : undefined}
          />
          <FrameLiveBadge frame={frame} />
        </div>
      </A>
      <FrameImageRefreshButton frameId={frame.id} />
      {otherSceneObscured && liveSceneId ? (
        <div
          role="status"
          // Click-through: only the notice and its button take the pointer,
          // so the refresh button and the link underneath keep working.
          className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 px-4 text-center"
        >
          <div className="max-w-full rounded-xl bg-white/90 px-3 py-2 text-xs leading-5 text-slate-700 shadow-sm ring-1 ring-slate-200/80 backdrop-blur-sm dark:bg-slate-900/85 dark:text-slate-200 dark:ring-slate-600/70">
            <div className="font-semibold text-slate-900 dark:text-white">A different scene is live</div>
            <div className="truncate">
              {liveSceneName ? `The frame is showing “${liveSceneName}”.` : 'The frame is showing another scene.'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => showLiveSceneAnyway(liveSceneId)}
            className="frameos-secondary-button pointer-events-auto rounded-lg px-2.5 py-1 text-xs font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Show anyway
          </button>
        </div>
      ) : null}
    </div>
  )
}
