import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { FrameImage } from '../../../../components/FrameImage'

export interface ImageProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string
}

export function Image(props: ImageProps) {
  const { frameId } = useValues(frameLogic)
  return <FrameImage frameId={frameId} sceneId="image" {...props} />
}
