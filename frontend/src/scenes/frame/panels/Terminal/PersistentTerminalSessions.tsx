import { useMountedLogic, useValues } from 'kea'
import { framesModel } from '../../../../models/framesModel'
import { workspaceLogic } from '../../../workspace/workspaceLogic'
import { terminalLogic } from './terminalLogic'
import type { FrameId } from '../../../../types'

function PersistentTerminalSession({ frameId }: { frameId: FrameId }): null {
  useMountedLogic(terminalLogic({ frameId }))
  return null
}

export function PersistentTerminalSessions(): JSX.Element {
  const { terminalSessionFrameIds } = useValues(workspaceLogic)
  const { frames } = useValues(framesModel)
  const mountedFrameIds = terminalSessionFrameIds.filter((frameId) => frames[frameId])

  return (
    <>
      {mountedFrameIds.map((frameId) => (
        <PersistentTerminalSession key={frameId} frameId={frameId} />
      ))}
    </>
  )
}
