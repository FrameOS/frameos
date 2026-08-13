import { A } from 'kea-router'
import clsx from 'clsx'

import { FrameImage, FrameImageRefreshButton } from '../../components/FrameImage'
import type { FrameType } from '../../types'
import { urls } from '../../urls'
import { sceneIsActive } from './FrameDashboardSurface'
import { FrameLiveBadge } from './FrameLiveBadge'

const activeSurfaceClassName = 'frameos-active-surface'

export function FrameSidebarPreview({
  frame,
  active = false,
  className,
  mediaClassName,
}: {
  frame: FrameType
  active?: boolean
  className?: string
  mediaClassName?: string
}): JSX.Element {
  const activeScene = frame.scenes?.find((scene) => sceneIsActive(scene, frame.active_scene_id))
  return (
    <div
      className={clsx(
        'frameos-card relative overflow-hidden rounded-2xl border bg-white/65 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-slate-300/35',
        active ? activeSurfaceClassName : 'border-white/80',
        className
      )}
    >
      <A
        href={urls.frame(frame.id, 'preview')}
        className="block h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <div className={clsx('frameos-card-media relative h-[158px] bg-slate-100', mediaClassName)}>
          <FrameImage
            frameId={frame.id}
            refreshable={false}
            objectFit="contain"
            className="h-full w-full"
            wasmFallback={activeScene ? { sceneId: activeScene.id } : undefined}
          />
          <FrameLiveBadge frame={frame} />
        </div>
      </A>
      <FrameImageRefreshButton frameId={frame.id} />
    </div>
  )
}
