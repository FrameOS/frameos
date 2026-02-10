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
  if (frame.enable_tls) {
    const tlsPort = frame.tls_port ?? 0
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

export function frameUrl(frame: FrameType): string | null {
  const { scheme, port } = frameSchemeAndPort(frame)
  const url = `${scheme}://${frame.frame_host}:${port}/`
  if (frame.frame_access === 'public' || frame.frame_access === 'protected') {
    return url
  } else {
    return `${url}?k=${frame.frame_access_key}`
  }
}

export function frameControlUrl(frame: FrameType): string | null {
  const { scheme, port } = frameSchemeAndPort(frame)
  const url = `${scheme}://${frame.frame_host}:${port}/c`
  if (frame.frame_access === 'public') {
    return url
  } else {
    return `${url}?k=${frame.frame_access_key}`
  }
}

export function frameImageUrl(frame: FrameType): string | null {
  const { scheme, port } = frameSchemeAndPort(frame)
  const url = `${scheme}://${frame.frame_host}:${port}/image`
  if (frame.frame_access === 'public' || frame.frame_access === 'protected') {
    return url
  } else {
    return `${url}?k=${frame.frame_access_key}`
  }
}

interface FrameConnectionProps {
  frame: FrameType
}

export function FrameConnection({ frame }: FrameConnectionProps): JSX.Element | null {
  return (frame?.active_connections ?? 0) > 0 ? (
    <span title="FrameOS Agent connected">{frame?.agent?.agentRunCommands ? '🟢' : '🟠'}</span>
  ) : null
}
