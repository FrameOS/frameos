import { SceneWorkspace } from '../workspace/SceneWorkspace'

interface FrameSceneProps {
  id: string
}

export function Frame({ id }: FrameSceneProps): JSX.Element {
  return <SceneWorkspace frameId={id} />
}

export default Frame
