import { useMountedLogic } from 'kea'

import { Frame } from '../../../../../frontend/src/scenes/frame/Frame'
import { socketLogic } from '../../../../../frontend/src/scenes/socketLogic'

interface ControlProps {
  id?: string
}

export const Control = ({ id }: ControlProps) => {
  useMountedLogic(socketLogic)

  const fallbackId =
    typeof window !== 'undefined' && (window as any).FRAMEOS_APP_CONFIG?.frameId
      ? String((window as any).FRAMEOS_APP_CONFIG?.frameId)
      : '1'
  return <Frame id={id ?? fallbackId} />
}

export default Control
