import Spinner from '../components/Spinner'
import { FrameType } from '../types'

export function frameHost(frame: FrameType): string {
  if (!frame.ssh_user || frame.ssh_user === 'pi') {
    return frame.frame_host
  }
  return `${frame.ssh_user}@${frame.frame_host}`
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

export function frameUrl(frame: FrameType): string {
  return `http${frame.frame_port % 1000 === 443 ? 's' : ''}://${frame.frame_host}:${frame.frame_port}/kiosk`
}
