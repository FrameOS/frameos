import { FrameImagePreviewButton, FrameImageRefreshButton } from '../../components/FrameImage'
import type { FrameType } from '../../types'
import { FrameLiveBadge } from './FrameLiveBadge'

export function FrameImageOverlayControls({
  frame,
  sceneId,
  showLive = true,
  showPreview = true,
  showRefresh = true,
}: {
  frame: FrameType
  sceneId?: string
  showLive?: boolean
  showPreview?: boolean
  showRefresh?: boolean
}): JSX.Element {
  return (
    <>
      {showLive ? <FrameLiveBadge frame={frame} className="right-3 top-3 z-10" /> : null}
      {showRefresh ? <FrameImageRefreshButton frameId={frame.id} sceneId={sceneId} /> : null}
      {showPreview ? <FrameImagePreviewButton frameId={frame.id} /> : null}
    </>
  )
}
