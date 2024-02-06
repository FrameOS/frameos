import { Spinner } from '../components/Spinner'
import { FrameType } from '../types'

export function frameHost(frame: FrameType): string {
  if (!frame.ssh_user || frame.ssh_user === 'pi') {
    return frame.frame_host
  }
  return `${frame.ssh_user}@${frame.frame_host}`
}

export const frameStatusWithSpinner = ['deploying', 'preparing', 'rendering', 'restarting', 'starting']

export function frameStatus(frame: FrameType): JSX.Element {
  let status = frame.status
  if (frame.last_log_at) {
    const lastLogAt = new Date(frame.last_log_at)
    const now = new Date()
    if (now.getTime() - lastLogAt.getTime() > 1000 * 60 * 60) {
      status = 'stale'
    }
  }

  return (
    <div className="flex gap-2 items-center">
      {status}
      {frameStatusWithSpinner.includes(status) ? <Spinner /> : null}
    </div>
  )
}

export function frameUrl(frame: FrameType): string | null {
  const url = `http${frame.frame_port % 1000 === 443 ? 's' : ''}://${frame.frame_host}:${frame.frame_port}/`
  if (frame.frame_access === 'public' || frame.frame_access === 'protected') {
    return url
  } else if (frame.frame_access === 'private') {
    return `${url}?k=${frame.frame_access_key}`
  }
  return null
}

export function frameControlUrl(frame: FrameType): string | null {
  const url = `http${frame.frame_port % 1000 === 443 ? 's' : ''}://${frame.frame_host}:${frame.frame_port}/c`
  if (frame.frame_access === 'public') {
    return url
  } else if (frame.frame_access === 'private' || frame.frame_access === 'protected') {
    return `${url}?k=${frame.frame_access_key}`
  }
  return null
}
