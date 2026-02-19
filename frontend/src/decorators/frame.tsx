import { Spinner } from '../components/Spinner'
import { FrameType } from '../types'

export function frameHost(frame: FrameType): string {
  if (!frame.ssh_user || frame.ssh_user === 'pi') {
    return frame.frame_host
  }
  return `${frame.ssh_user}@${frame.frame_host}`
}

export const frameStatusWithSpinner = ['deploying', 'preparing', 'rendering', 'restarting', 'starting']

function frameSchemeAndPort(frame: FrameType): { scheme: string; port: number } {
  if (frame.https_proxy?.enable) {
    const tlsPort = frame.https_proxy?.port ?? 0
    return {
      scheme: 'https',
      port: tlsPort > 0 ? tlsPort : frame.frame_port,
    }
  }
  return { scheme: 'http', port: frame.frame_port }
}

export function frameStatus(frame: FrameType): JSX.Element {
  let status = frame.status
  if (frame.last_log_at) {
    const lastLogAt = new Date(frame.last_log_at)
    const now = new Date()
    if (now.getTime() - lastLogAt.getTime() > 1000 * 60 * 60) {
      status = 'stale'
    }
  }

  if (frame.status === 'ready' && (frame?.active_connections ?? 0) > 0) {
    status = 'connected'
  }

  return (
    <div className="flex gap-2 items-center">
      {status}
      {frameStatusWithSpinner.includes(status) ? <Spinner /> : null}
    </div>
  )
}

export function frameRootUrl(frame: FrameType): string {
  const { scheme, port } = frameSchemeAndPort(frame)
  return `${scheme}://${frame.frame_host}:${port}`
}

export function frameUrl(frame: FrameType): string | null {
  const url = frameRootUrl(frame)
  if (frame.frame_access === 'public' || frame.frame_access === 'protected') {
    return url
  } else {
    return `${url}?k=${frame.frame_access_key}`
  }
}

export function frameControlUrl(frame: FrameType): string | null {
  const url = frameRootUrl(frame) + '/c'
  if (frame.frame_access === 'public') {
    return url
  } else {
    return `${url}?k=${frame.frame_access_key}`
  }
}

export function frameImageUrl(frame: FrameType): string | null {
  const url = frameRootUrl(frame) + `/image`
  if (frame.frame_access === 'public' || frame.frame_access === 'protected') {
    return url
  } else {
    return `${url}?k=${frame.frame_access_key}`
  }
}

export function frameNewFrontendUrl(frame: FrameType): string | null {
  const url = `http${frame.frame_port % 1000 === 443 ? 's' : ''}://${frame.frame_host}:${frame.frame_port}/new`
  if (frame.frame_access === 'public') {
    return url
  }
  return `${url}?k=${frame.frame_access_key}`
}

interface FrameConnectionProps {
  frame: FrameType
}

export function FrameConnection({ frame }: FrameConnectionProps): JSX.Element | null {
  return (frame?.active_connections ?? 0) > 0 ? (
    <span title="FrameOS Agent connected">{frame?.agent?.agentRunCommands ? '🟢' : '🟠'}</span>
  ) : null
}
