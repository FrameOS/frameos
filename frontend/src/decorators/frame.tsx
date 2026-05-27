import { Spinner } from '../components/Spinner'
import { FrameType, LogType } from '../types'
import { frameAdminPath } from '../utils/frameAdmin'
import { withFrameAdminLoginParams } from '../utils/frameAdminLoginParams'

export function logUpdatesFrameActivity(log: Pick<LogType, 'type' | 'line'>): boolean {
  return log.type === 'webhook'
}

export function frameHost(frame: FrameType): string {
  if (!frame.ssh_user || frame.ssh_user === 'pi') {
    return frame.frame_host
  }
  return `${frame.ssh_user}@${frame.frame_host}`
}

export const frameStatusWithSpinner = ['deploying', 'preparing', 'rendering', 'restarting', 'starting']

function parseFrameTimestamp(timestamp?: string | null): number {
  if (!timestamp) {
    return NaN
  }
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)
  return Date.parse(hasTimeZone ? timestamp : `${timestamp}Z`)
}

function pluralize(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`
}

export function formatFrameRelativeTime(timestamp?: string | null): string | null {
  const time = parseFrameTimestamp(timestamp)
  if (!Number.isFinite(time)) {
    return null
  }

  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (seconds < 45) {
    return 'just now'
  }
  if (seconds < 90) {
    return '1 minute ago'
  }

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return pluralize(minutes, 'minute')
  }
  if (minutes < 90) {
    return '1 hour ago'
  }

  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return pluralize(hours, 'hour')
  }
  if (hours < 36) {
    return '1 day ago'
  }

  const days = Math.round(hours / 24)
  return pluralize(days, 'day')
}

export function frameIsStale(frame: FrameType): boolean {
  if (!frame.last_log_at) {
    return false
  }
  const lastLogAt = parseFrameTimestamp(frame.last_log_at)
  return Number.isFinite(lastLogAt) && Date.now() - lastLogAt > 1000 * 60 * 60
}

function frameHasActivityLog(frame: FrameType): boolean {
  return Number.isFinite(parseFrameTimestamp(frame.last_log_at))
}

export function frameIsHealthy(frame: FrameType): boolean {
  return frame.status === 'ready' && !frameIsStale(frame)
}

export function frameIsActive(frame: FrameType): boolean {
  if ((frame.active_connections ?? 0) > 0) {
    return true
  }
  if (frameIsStale(frame)) {
    return false
  }
  if (frameHasActivityLog(frame)) {
    return true
  }
  return frame.status === 'ready' || frameStatusWithSpinner.includes(frame.status)
}

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

export function frameStatusLabel(frame: FrameType): string {
  let status = frame.status
  if (frameIsStale(frame)) {
    status = 'stale'
  }

  if (frame.status === 'ready' && (frame?.active_connections ?? 0) > 0) {
    status = 'connected'
  }

  return status
}

export function frameNeedsInitialDeploy(frame: FrameType): boolean {
  return !frame.last_successful_deploy_at
}

export function frameStatusDescription(frame: FrameType): string {
  if (frameNeedsInitialDeploy(frame)) {
    return 'waiting for first deploy'
  }

  const status = frameStatusLabel(frame)
  const relativeTime = formatFrameRelativeTime(frame.last_log_at)
  const logDescription = relativeTime ? `last seen ${relativeTime}` : 'no logs yet'

  return `${status} - ${logDescription}`
}

export function frameStatus(frame: FrameType): JSX.Element {
  const status = frameStatusLabel(frame)

  return (
    <span className="inline-flex items-center gap-2">
      {frameStatusDescription(frame)}
      {frameStatusWithSpinner.includes(status) ? <Spinner /> : null}
    </span>
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

function frameControlPath(frame: FrameType): string {
  return '/c'
}

export function frameControlUrl(frame: FrameType): string | null {
  const url = frameRootUrl(frame) + frameControlPath(frame)
  if (frame.frame_access === 'public' || !frame.frame_access_key) {
    return url
  } else {
    return `${url}?k=${frame.frame_access_key}`
  }
}

export function frameAdminUrl(frame: FrameType): string | null {
  if (!frame.frame_admin_auth?.enabled) {
    return null
  }
  const url = frameRootUrl(frame) + frameAdminPath()
  return withFrameAdminLoginParams(url, frame.frame_admin_auth.user || '', frame.frame_admin_auth.pass || '')
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
