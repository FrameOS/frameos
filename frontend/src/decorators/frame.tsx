import Spinner from '../components/Spinner'
import { FrameType } from '../types'

export function frameHost(frame: FrameType): string {
  if (!frame.ssh_user || frame.ssh_user === 'pi') {
    return frame.host
  }
  return `${frame.ssh_user}@${frame.host}`
}

export const frameStatusWithSpinner = ['deploying', 'fetching', 'refreshing', 'restarting', 'starting']

export function frameStatus(frame: FrameType): JSX.Element {
  return (
    <div className="flex gap-2 items-center">
      {frame.status}
      {frameStatusWithSpinner.includes(frame.status) ? <Spinner /> : null}
    </div>
  )
}
