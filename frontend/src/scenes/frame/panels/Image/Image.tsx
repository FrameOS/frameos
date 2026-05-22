import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { FrameImage, FrameImageProps } from '../../../../components/FrameImage'

export type ImageProps = Omit<FrameImageProps, 'frameId'>

export function Image(props: ImageProps) {
  const { frameId } = useValues(frameLogic)
  return <FrameImage frameId={frameId} {...props} />
}
