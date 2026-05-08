import { useMountedLogic, useValues } from 'kea'

import { appsModel } from '../../../../../frontend/src/models/appsModel'
import { entityImagesModel } from '../../../../../frontend/src/models/entityImagesModel'
import { framesModel } from '../../../../../frontend/src/models/framesModel'
import { Frame } from '../../../../../frontend/src/scenes/frame/Frame'
import { socketLogic } from '../../../../../frontend/src/scenes/socketLogic'
import { adminLogic } from './adminLogic'

interface AdminProps {
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

export default function Admin({ id }: AdminProps) {
  const resolvedFrameId = resolveFrameId(id)

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
    return <Frame id={resolvedFrameId} />
  }

  return <div>Loading...</div>
}
