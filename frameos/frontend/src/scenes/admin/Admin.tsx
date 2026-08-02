import { useMountedLogic, useValues } from 'kea'
import { useEffect, useRef, type ReactNode } from 'react'

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

  // Navigate from an effect, once. Assigning window.location during render
  // fires again on every re-render this component happens to get while
  // unauthenticated (framesModel and socketLogic both push updates through
  // here), and each assignment aborts the navigation the previous one
  // started — the browser reports that as net::ERR_ABORTED and the login
  // page may never actually load.
  const redirectedToLogin = useRef(false)
  const needsLogin = !isChecking && !isAuthenticated
  useEffect(() => {
    if (needsLogin && !redirectedToLogin.current && typeof window !== 'undefined') {
      redirectedToLogin.current = true
      window.location.href = '/login'
    }
  }, [needsLogin])

  if (isChecking) {
    return <div>Loading...</div>
  }

  if (!isAuthenticated) {
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
