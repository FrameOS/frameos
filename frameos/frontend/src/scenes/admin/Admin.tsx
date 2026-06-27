import { useMountedLogic, useValues } from 'kea'
import type { ReactNode } from 'react'

import { appsModel } from '../../../../../frontend/src/models/appsModel'
import { entityImagesModel } from '../../../../../frontend/src/models/entityImagesModel'
import { framesModel } from '../../../../../frontend/src/models/framesModel'
import { Frame } from '../../../../../frontend/src/scenes/frame/Frame'
import { AppsWorkspace } from '../../../../../frontend/src/scenes/workspace/AppsWorkspace'
import { SceneWorkspace } from '../../../../../frontend/src/scenes/workspace/SceneWorkspace'
import { socketLogic } from '../../../../../frontend/src/scenes/socketLogic'
import { adminLogic } from './adminLogic'

interface AdminProps {
  id?: string
  frameId?: string
  sceneId?: string
  nodeId?: string
}

const resolveFrameId = (...ids: Array<string | undefined>) => {
  for (const id of ids) {
    if (id && id.trim()) {
      return id
    }
  }
  if (typeof window !== 'undefined') {
    const configFrameId = (window as any).FRAMEOS_APP_CONFIG?.frameId
    if (configFrameId !== undefined && configFrameId !== null) {
      const stringFrameId = String(configFrameId).trim()
      if (stringFrameId) {
        return stringFrameId
      }
    }
  }
  return '1'
}

function AdminGate({ children }: { children: ReactNode }) {
  useMountedLogic(adminLogic)
  useMountedLogic(socketLogic)
  useMountedLogic(appsModel)
  useMountedLogic(entityImagesModel)

  const { framesLoaded } = useValues(framesModel)
  const { isChecking, isAuthenticated } = useValues(adminLogic)

  if (isChecking) {
    return <div>Loading...</div>
  }

  if (!isAuthenticated) {
    if (typeof window !== 'undefined') {
      window.location.href = '/login'
    }
    return <div>Redirecting to login...</div>
  }

  if (framesLoaded) {
    return <>{children}</>
  }

  return <div>Loading...</div>
}

export default function Admin({ id, frameId }: AdminProps) {
  const resolvedFrameId = resolveFrameId(id, frameId)

  return (
    <AdminGate>
      <Frame id={resolvedFrameId} />
    </AdminGate>
  )
}

export function AdminScene({ frameId, sceneId }: AdminProps) {
  return (
    <AdminGate>
      <SceneWorkspace frameId={resolveFrameId(frameId)} sceneId={sceneId} />
    </AdminGate>
  )
}

export function AdminApps({ frameId, sceneId, nodeId }: AdminProps) {
  return (
    <AdminGate>
      <AppsWorkspace frameId={frameId} sceneId={sceneId} nodeId={nodeId} />
    </AdminGate>
  )
}
