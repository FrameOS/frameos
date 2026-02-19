import { useActions, useMountedLogic, useValues } from 'kea'

import { Frame } from '../../../../../frontend/src/scenes/frame/Frame'
import { socketLogic } from '../../../../../frontend/src/scenes/socketLogic'
import { framesModel } from '../../../../../frontend/src/models/framesModel'
import { appsModel } from '../../../../../frontend/src/models/appsModel'
import { entityImagesModel } from '../../../../../frontend/src/models/entityImagesModel'
import { adminLogic } from './adminLogic'

interface ControlProps {
  id?: string
}

const resolveFrameId = (id?: string) => {
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

export const Control = ({ id }: ControlProps) => {
  const resolvedFrameId = resolveFrameId(id)
  console.log('Resolved frame ID:', resolvedFrameId)

  useMountedLogic(adminLogic)
  useMountedLogic(socketLogic)
  useMountedLogic(appsModel)
  useMountedLogic(entityImagesModel)

  const { framesLoaded } = useValues(framesModel)
  const { isChecking, isAuthenticated } = useValues(adminLogic)
  const { logout } = useActions(adminLogic)

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
      <div>
        <div className="fixed right-4 top-4 z-50">
          <button className="rounded bg-slate-800 px-3 py-2 text-sm text-white" onClick={logout}>
            Logout
          </button>
        </div>
        <Frame id={resolvedFrameId} />
      </div>
    )
  }
  return <div>Loading...</div>
}

export default Control
