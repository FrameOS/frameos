import Spinner from '../components/Spinner'
import { FrameType } from '../types'

export function frameHost(frame: FrameType): string {
  if (!frame.ssh_user || frame.ssh_user === 'pi') {
    return frame.host
  }
  return `${frame.ssh_user}@${frame.host}`
}

export function frameStatus(frame: FrameType): JSX.Element {
  return (
    <div className="flex gap-2 items-center">
      {frame.status}
      {frame.status === 'initializing' ? <Spinner /> : null}
    </div>
  )
}
