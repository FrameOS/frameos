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

function parseFrameTimestamp(timestamp?: string | number | null): number {
  if (typeof timestamp === 'number') {
    return timestamp
  }
  if (!timestamp) {
    return NaN
  }
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)
  return Date.parse(hasTimeZone ? timestamp : `${timestamp}Z`)
}

function pluralize(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`
}

export function formatFrameRelativeTime(timestamp?: string | number | null, now: number = Date.now()): string | null {
  const time = parseFrameTimestamp(timestamp)
  if (!Number.isFinite(time)) {
    return null
  }

  const seconds = Math.max(0, Math.round((now - time) / 1000))
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

// "5 min", "2 h 10 min", "3 d 4 h" — the resolution someone waiting for a
// frame to come back actually wants (the "ago" formatter's "2 hours" is fine
// for the past, not for "when can I expect my deploy to land").
export function formatFrameDuration(ms: number): string {
  const totalMinutes = Math.round(Math.max(0, ms) / 60000)
  if (totalMinutes < 1) {
    return 'under a minute'
  }
  if (totalMinutes < 60) {
    return `${totalMinutes} min`
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) {
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours ? `${days} d ${remainingHours} h` : `${days} day${days === 1 ? '' : 's'}`
}

// "in 5 min" / "any moment now"; `approx` prefixes the duration ("in ~5 min")
// for estimates the device did not announce itself.
export function formatFrameRelativeFuture(time: number, now: number = Date.now(), approx = ''): string {
  const ms = time - now
  if (ms < 45_000) {
    return 'any moment now'
  }
  return `in ${approx}${formatFrameDuration(ms)}`
}

// How long past its expected wake a sleeping frame is still "asleep" rather
// than "overdue". A wake is a cold boot — panel init, Wi-Fi (up to 45 s),
// SNTP, then the dial — so the socket lands a good minute after the timer.
const checkinGraceMs = 2 * 60 * 1000

/** The firmware's own "a cell is present" threshold (FOS_BATTERY_PRESENT_MV). */
const batteryPresentMillivolts = 2500

export interface FrameCheckin {
  /** sleeping: expected back at wakeAt; overdue: wakeAt passed, still not seen. */
  kind: 'sleeping' | 'overdue'
  /** Epoch ms when the frame is expected to redial. */
  wakeAt: number
  /** Epoch ms of the next panel refresh when it is a separate, later event
   * (the wake is only a command check-in); null when unknown or the same. */
  renderAt: number | null
  /** true: the device announced this itself (next_wake_at, firmware from
   * 2026.8.41); false: estimated from its power settings and last_seen_at. */
  announced: boolean
  reason: string | null
}

function frameDeviceConfigValue(frame: FrameType, camel: string, snake: string): unknown {
  const config = (frame.device_config ?? {}) as Record<string, unknown>
  return config[camel] ?? config[snake]
}

// Older firmware never announces its sleeps; mirror the render task's own
// decision (embedded/esp32/main/fos_client.c) from the settings the control
// plane pushed: the frame sleeps when deep_sleep is on, or deep_sleep_on_battery
// is on and a cell is present, and it comes back every wake_check_seconds
// (when set and shorter) or every render interval. An estimate — the scene's
// own refreshInterval can stretch the real cycle — hence the "~" in the copy.
function estimatedCheckinPeriodSeconds(frame: FrameType): number | null {
  const deepSleep = frame.deep_sleep ?? frameDeviceConfigValue(frame, 'deepSleep', 'deep_sleep')
  const deepSleepOnBattery =
    frame.deep_sleep_on_battery ?? frameDeviceConfigValue(frame, 'deepSleepOnBattery', 'deep_sleep_on_battery')
  const metrics = frame.last_metrics ?? {}
  const onBattery =
    typeof metrics.onBattery === 'boolean'
      ? metrics.onBattery
      : typeof metrics.batteryMillivolts === 'number'
      ? metrics.batteryMillivolts >= batteryPresentMillivolts
      : false
  if (deepSleep !== true && !(deepSleepOnBattery === true && onBattery)) {
    return null
  }
  const wakeCheck = Number(
    frame.wake_check_seconds ?? frameDeviceConfigValue(frame, 'wakeCheckSeconds', 'wake_check_seconds') ?? 0
  )
  const interval = Number(frame.interval) > 0 ? Number(frame.interval) : 300
  const period = wakeCheck >= 60 && wakeCheck < interval ? wakeCheck : interval
  return Math.min(Math.max(period, 60), 7 * 86400)
}

/**
 * What a disconnected deep-sleeping frame is up to: asleep until `wakeAt`
 * (a deploy queued now lands then), or overdue — it should have redialed
 * already and has not. null for a frame that is online, or that is not
 * known to sleep (a plain offline Pi, a USB-powered board that stays
 * connected).
 */
export function frameCheckin(frame: FrameType, now: number = Date.now()): FrameCheckin | null {
  if (frame.connected === true || (frame.active_connections ?? 0) > 0) {
    return null
  }
  const announcedWakeAt = parseFrameTimestamp(frame.next_wake_at)
  if (Number.isFinite(announcedWakeAt)) {
    const renderAt = parseFrameTimestamp(frame.next_render_at)
    return {
      kind: now > announcedWakeAt + checkinGraceMs ? 'overdue' : 'sleeping',
      wakeAt: announcedWakeAt,
      renderAt: Number.isFinite(renderAt) && renderAt > announcedWakeAt + 60_000 ? renderAt : null,
      announced: true,
      reason: frame.sleep_reason ?? null,
    }
  }
  const period = estimatedCheckinPeriodSeconds(frame)
  const lastSeenAt = parseFrameTimestamp(frameActivityTimestamp(frame))
  if (period === null || !Number.isFinite(lastSeenAt)) {
    return null
  }
  const wakeAt = lastSeenAt + period * 1000
  // An estimate gets half a cycle of extra slack before it is called overdue.
  const graceMs = checkinGraceMs + (period * 1000) / 2
  return {
    kind: now > wakeAt + graceMs ? 'overdue' : 'sleeping',
    wakeAt,
    renderAt: null,
    announced: false,
    reason: null,
  }
}

/** "asleep · wakes in 5 min · renders in 2 h" / "overdue · expected 10 minutes ago · last seen 40 minutes ago". */
export function frameCheckinDescription(
  frame: FrameType,
  checkin: FrameCheckin | null = frameCheckin(frame),
  now: number = Date.now()
): string | null {
  if (!checkin) {
    return null
  }
  const approx = checkin.announced ? '' : '~'
  if (checkin.kind === 'sleeping') {
    const parts = [`asleep · wakes ${formatFrameRelativeFuture(checkin.wakeAt, now, approx)}`]
    if (checkin.renderAt) {
      parts.push(`renders ${formatFrameRelativeFuture(checkin.renderAt, now)}`)
    }
    return parts.join(' · ')
  }
  const lastSeen = formatFrameRelativeTime(frameActivityTimestamp(frame), now)
  return `overdue · expected ${approx}${formatFrameRelativeTime(checkin.wakeAt, now)}${
    lastSeen ? ` · last seen ${lastSeen}` : ''
  }`
}

export function frameIsStale(frame: FrameType): boolean {
  // A frame asleep on schedule is behaving, however long ago it was last
  // seen — a 12-hour wake check must not read as "stale" for 11 of them.
  if (frameCheckin(frame)?.kind === 'sleeping') {
    return false
  }
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
  // Cloud frames: `status` is the enrollment state (pending/active/revoked),
  // which says nothing about whether the device is reachable — that is the
  // hub's `connected` flag. "active - last seen 3 hours ago" read as if the
  // frame were fine.
  if (frame.status === 'active' && typeof frame.connected === 'boolean') {
    return frame.connected ? 'online' : frameIsStale(frame) ? 'stale' : 'offline'
  }
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

/**
 * The one-line "what is it doing" under a frame's name: a sleeping frame
 * says when it is back ("asleep · wakes in 5 min"), an overdue one says so,
 * everything else says when it was last heard from.
 */
export function frameActivityDescription(frame: FrameType): string {
  if (frameNeedsInitialDeploy(frame)) {
    return 'waiting for first deploy'
  }
  const checkin = frameCheckinDescription(frame)
  if (checkin) {
    return checkin
  }
  // last_log_at is a backend column; the cloud's frameSummary never serves
  // it, but the hub bumps last_seen_at on every log, metric and state the
  // device sends — without the fallback every cloud frame read "no logs yet".
  const relativeTime = formatFrameRelativeTime(frameActivityTimestamp(frame))
  return relativeTime ? `last seen ${relativeTime}` : 'no logs yet'
}

export function frameStatusDescription(frame: FrameType): string {
  if (frameNeedsInitialDeploy(frame)) {
    return 'waiting for first deploy'
  }
  const checkin = frameCheckinDescription(frame)
  if (checkin) {
    return checkin
  }

  return `${frameStatusLabel(frame)} - ${frameActivityDescription(frame)}`
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
