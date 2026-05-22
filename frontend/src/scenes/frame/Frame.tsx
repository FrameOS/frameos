import { FrameWorkspace } from '../workspace/FrameWorkspace'

interface FrameSceneProps {
  id: string
}

export function Frame({ id }: FrameSceneProps): JSX.Element {
  return <FrameWorkspace id={id} />
}

export default Frame
