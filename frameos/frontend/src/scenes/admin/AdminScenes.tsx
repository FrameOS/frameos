import { SceneWorkspace } from '../../../../../frontend/src/scenes/workspace/SceneWorkspace'
import { AdminGate, resolveFrameId } from './Admin'

interface AdminScenesProps {
  frameId?: string
  sceneId?: string
}

export default function AdminScenes({ frameId, sceneId }: AdminScenesProps) {
  return (
    <AdminGate>
      <SceneWorkspace frameId={resolveFrameId(frameId)} sceneId={sceneId} />
    </AdminGate>
  )
}
