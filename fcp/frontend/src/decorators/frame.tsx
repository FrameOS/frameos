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
    <>
      {frame.status === 'initializing' ? <Spinner className="mr-2" /> : null}
      {frame.status}
    </>
  )
}
