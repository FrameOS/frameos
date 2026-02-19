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
      <Frame id={resolvedFrameId} />
    )
  }
  return <div>Loading...</div>
}

export default Control
