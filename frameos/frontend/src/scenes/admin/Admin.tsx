import { useMountedLogic, useValues } from 'kea'

import { appsModel } from '../../../../../frontend/src/models/appsModel'
import { entityImagesModel } from '../../../../../frontend/src/models/entityImagesModel'
import { framesModel } from '../../../../../frontend/src/models/framesModel'
import { longRunningTasksModel } from '../../../../../frontend/src/models/longRunningTasksModel'
import { LongRunningTaskToasts } from '../../../../../frontend/src/components/LongRunningTaskToasts'
import { Frame } from '../../../../../frontend/src/scenes/frame/Frame'
import { socketLogic } from '../../../../../frontend/src/scenes/socketLogic'
import { adminLogic } from './adminLogic'

interface AdminProps {
  id?: string
}

export const resolveFrameId = (id?: string) => {
  if (id && id.trim()) {
    return id
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

// Shared bootstrap for every /admin view: checks the admin session, mounts the
// models the workspaces depend on, and waits for the frame to load.
export function AdminGate({ children }: { children: JSX.Element }): JSX.Element {
  useMountedLogic(adminLogic)
  useMountedLogic(socketLogic)
  useMountedLogic(appsModel)
  useMountedLogic(entityImagesModel)
  useMountedLogic(longRunningTasksModel)

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
    return (
      <>
        {children}
        <LongRunningTaskToasts />
      </>
    )
  }

  return <div>Loading...</div>
}

export default function Admin({ id }: AdminProps) {
  return (
    <AdminGate>
      <Frame id={resolveFrameId(id)} />
    </AdminGate>
  )
}
