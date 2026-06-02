import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { FrameImage, FrameImageProps, FrameImageRefreshButton } from '../../../../components/FrameImage'

export type ImageProps = Omit<FrameImageProps, 'frameId'>

export function Image(props: ImageProps) {
  const { frameId } = useValues(frameLogic)
  return (
    <div className="relative h-full w-full">
      <FrameImage frameId={frameId} refreshable={false} {...props} />
      <FrameImageRefreshButton frameId={frameId} />
    </div>
  )
}
