import { AppsWorkspace } from '../../../../../frontend/src/scenes/workspace/AppsWorkspace'
import { SYSTEM_APPS_ROUTE_TOKEN } from '../../../../../frontend/src/scenes/workspace/appsWorkspaceLogic'
import { AdminGate, resolveFrameId } from './Admin'

interface AdminAppsProps {
  frameId?: string
  sceneId?: string
  nodeId?: string
}

export default function AdminApps({ frameId, sceneId, nodeId }: AdminAppsProps) {
  // "/admin/apps/system/..." browses the system app catalog; anything else is
  // scoped to the device's own frame.
  const resolvedFrameId = frameId === SYSTEM_APPS_ROUTE_TOKEN ? frameId : resolveFrameId(frameId)
  return (
    <AdminGate>
      <AppsWorkspace frameId={resolvedFrameId} sceneId={sceneId} nodeId={nodeId} />
    </AdminGate>
  )
}
