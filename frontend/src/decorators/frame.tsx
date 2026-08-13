import { FrameConnectionDot } from '../components/FrameConnectionDot'
import { isCloudMode } from '../utils/cloudMode'
import { Spinner } from '../components/Spinner'
import { FrameType, LogType } from '../types'
import { frameAdminPath } from '../utils/frameAdmin'
import { withFrameAdminLoginParams } from '../utils/frameAdminLoginParams'

export function logUpdatesFrameActivity(log: Pick<LogType, 'type' | 'line'>): boolean {
  return log.type === 'webhook'
}

export function frameHost(frame: FrameType): string {
  // Cloud frames have no host at all — never hand back undefined, or every
  // `frame.name || frameHost(frame)` fallback turns into a crash downstream.
  const host = frame.frame_host ?? ''
  if (!frame.ssh_user || frame.ssh_user === 'pi') {
    return host
  }
  return `${frame.ssh_user}@${host}`
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

// Cloud frames carry no last_log_at, only the hub-maintained last_seen_at —
// same substitution the sidebar status dots make.
function frameActivityTimestamp(frame: FrameType): string | null | undefined {
  return frame.last_log_at ?? frame.last_seen_at
}

export function frameIsStale(frame: FrameType): boolean {
  const activityAt = frameActivityTimestamp(frame)
  if (!activityAt) {
    return false
  }
  const lastActivityAt = parseFrameTimestamp(activityAt)
  return Number.isFinite(lastActivityAt) && Date.now() - lastActivityAt > 1000 * 60 * 60
}

export function frameHasActivityLog(frame: FrameType): boolean {
  return Number.isFinite(parseFrameTimestamp(frameActivityTimestamp(frame)))
}

export function frameIsHealthy(frame: FrameType): boolean {
  return frame.status === 'ready' && !frameIsStale(frame)
}

export function frameIsActive(frame: FrameType): boolean {
  if ((frame.active_connections ?? 0) > 0) {
    return true
  }
  // The hub keeps `connected` live for cloud frames; an open device socket is
  // as active as a frame gets. Everything below is heuristics for frames that
  // carry no such flag (the backend) or are between reconnects.
  if (frame.connected === true) {
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
  // Cloud-managed frames are judged by what the DEVICE acked, not by a
  // deploy record. `last_successful_deploy_at` and `mode` are backend-only
  // columns that frameSummary does not return, so the rule below read
  // undefined for both and called every cloud frame "waiting for first
  // deploy" — permanently, including frames that were rendering and shipping
  // logs. The cloud's equivalent of a deploy is a set_scenes the device
  // acknowledged, which is exactly what scenes_checksum records.
  if (isCloudMode() || frame.managed_by === 'cloud') {
    return !frame.scenes_checksum && !frameHasActivityLog(frame)
  }
  if ((frame.mode ?? 'rpios') === 'embedded' && frameHasActivityLog(frame)) {
    return false
  }
  return !frame.last_successful_deploy_at
}

export function frameStatusDescription(frame: FrameType): string {
  if (frameNeedsInitialDeploy(frame)) {
    return 'waiting for first deploy'
  }

  const status = frameStatusLabel(frame)
  // last_log_at is a backend column; the cloud's frameSummary never serves
  // it, but the hub bumps last_seen_at on every log, metric and state the
  // device sends — without the fallback every cloud frame read "no logs yet".
  const relativeTime = formatFrameRelativeTime(frame.last_log_at ?? frame.last_seen_at)
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
  if (!frame.frame_host) {
    return null
  }
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
  if (!frame.frame_host) {
    return null
  }
  const url = frameRootUrl(frame) + frameControlPath(frame)
  if (frame.frame_access === 'public' || !frame.frame_access_key) {
    return url
  } else {
    return `${url}?k=${frame.frame_access_key}`
  }
}

export function frameAdminUrl(frame: FrameType): string | null {
  // Virtual frames have no host at all; nothing to link to.
  if (!frame.frame_admin_auth?.enabled || !frame.frame_host) {
    return null
  }
  const url = frameRootUrl(frame) + frameAdminPath()
  try {
    return withFrameAdminLoginParams(url, frame.frame_admin_auth.user || '', frame.frame_admin_auth.pass || '')
  } catch {
    return null
  }
}

export function frameImageUrl(frame: FrameType): string | null {
  if (!frame.frame_host) {
    return null
  }
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
    <FrameConnectionDot
      title={
        frame?.agent?.agentRunCommands
          ? 'FrameOS Remote connected and ready to run commands'
          : 'FrameOS Remote connected'
      }
    />
  ) : null
}
