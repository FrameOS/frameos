import { useMountedLogic } from 'kea'

import { Frame } from '../../../../../frontend/src/scenes/frame/Frame'
import { socketLogic } from '../../../../../frontend/src/scenes/socketLogic'

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
  useMountedLogic(socketLogic)

  const resolvedFrameId = resolveFrameId(id)
  return <Frame id={resolvedFrameId} />
}

export default Control
