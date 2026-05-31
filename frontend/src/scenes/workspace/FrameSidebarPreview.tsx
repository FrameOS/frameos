import { A } from 'kea-router'
import { useActions } from 'kea'
import clsx from 'clsx'
import { ArrowPathIcon } from '@heroicons/react/24/outline'

import { FrameImage } from '../../components/FrameImage'
import { entityImagesModel } from '../../models/entityImagesModel'
import type { FrameType } from '../../types'
import { urls } from '../../urls'
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
  const { updateEntityImage } = useActions(entityImagesModel)

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
          <FrameImage frameId={frame.id} refreshable={false} objectFit="contain" className="h-full w-full" />
          <FrameLiveBadge frame={frame} />
        </div>
      </A>
      <button
        type="button"
        title="Refresh image"
        aria-label="Refresh image"
        onClick={() => updateEntityImage(`frames/${frame.id}`, 'image')}
        className="absolute left-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-lg bg-white/60 text-slate-500 opacity-70 shadow-sm ring-1 ring-slate-200/70 backdrop-blur transition hover:bg-white/90 hover:text-slate-800 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <ArrowPathIcon className="h-4 w-4" />
      </button>
    </div>
  )
}
