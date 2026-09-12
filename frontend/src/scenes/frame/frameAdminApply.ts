// What the device did with a settings save, and where the admin page has to
// go afterwards.
//
// On a standalone frame the settings page is served by the frame itself, so
// changing the port, turning HTTPS on or off, or making HTTPS the only way in
// moves the very page you are on. The device rebinds its listeners before it
// writes frame.json (frameos/src/frameos/server/routes/frame_api_routes.nim,
// POST /api/frames/@id) and reports the result under `apply`; this module
// turns that into "stay" or "go to this origin". Nothing here probes the new
// origin first: the device already bound the socket, and a probe could not
// tell a self-signed certificate from a dead port anyway.

export interface FrameApplyListener {
  address: string
  port: number
  tls: boolean
}

export type FrameApplyRuntime = 'none' | 'reload' | 'restart'

export interface FrameSaveApply {
  runtime: FrameApplyRuntime
  listeners: FrameApplyListener[]
  listeners_changed: boolean
  /** System steps queued on the device: 'timezone', 'mounts', 'driver_setup'. */
  system: string[]
}

export interface PageOrigin {
  protocol: string
  hostname: string
  port: string
}

/** The `apply` block of a save response, or null when the server sent none (the backend, an older frame). */
export function parseFrameSaveApply(body: unknown): FrameSaveApply | null {
  if (!body || typeof body !== 'object') {
    return null
  }
  const apply = (body as { apply?: unknown }).apply
  if (!apply || typeof apply !== 'object') {
    return null
  }
  const raw = apply as Partial<Record<keyof FrameSaveApply, unknown>>
  const runtime = raw.runtime === 'reload' || raw.runtime === 'restart' ? raw.runtime : 'none'
  const listeners = Array.isArray(raw.listeners)
    ? raw.listeners
        .filter(
          (entry): entry is FrameApplyListener =>
            !!entry &&
            typeof entry === 'object' &&
            typeof (entry as FrameApplyListener).address === 'string' &&
            typeof (entry as FrameApplyListener).port === 'number'
        )
        .map((entry) => ({ address: entry.address, port: entry.port, tls: entry.tls === true }))
    : []
  const system = Array.isArray(raw.system)
    ? raw.system.filter((entry): entry is string => typeof entry === 'string')
    : []
  return { runtime, listeners, listeners_changed: raw.listeners_changed === true, system }
}

function bareHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** Whether a listener bound to `address` answers requests the browser sends to `hostname`. */
export function listenerReachableFrom(listener: FrameApplyListener, hostname: string): boolean {
  const host = bareHostname(hostname).toLowerCase()
  if (listener.address === '' || listener.address === '0.0.0.0' || listener.address === '::') {
    return true
  }
  if (listener.address === '127.0.0.1' || listener.address === '::1') {
    // `exposeOnlyPort` binds plain HTTP to loopback: only a browser on the
    // frame itself still reaches it.
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  }
  return listener.address.toLowerCase() === host
}

function effectivePort(origin: PageOrigin): number {
  if (origin.port) {
    return Number(origin.port)
  }
  return origin.protocol === 'https:' ? 443 : 80
}

/**
 * The origin the admin page should move to after a save, or null to stay
 * where it is. Stays whenever the current scheme and port are still served
 * (a second listener coming up is not a reason to move), and when nothing
 * reachable is reported (an older frame, or listeners bound elsewhere).
 * Prefers keeping the scheme: an https page follows the HTTPS port, a plain
 * page the plain one, and only crosses over when its own scheme is gone.
 */
export function frameOriginAfterApply(origin: PageOrigin, listeners: FrameApplyListener[]): string | null {
  const reachable = listeners.filter((listener) => listenerReachableFrom(listener, origin.hostname))
  if (reachable.length === 0) {
    return null
  }
  const secure = origin.protocol === 'https:'
  const port = effectivePort(origin)
  if (reachable.some((listener) => listener.tls === secure && listener.port === port)) {
    return null
  }
  const target = reachable.find((listener) => listener.tls === secure) ?? reachable[0]
  if (!target) {
    return null
  }
  const scheme = target.tls ? 'https' : 'http'
  const defaultPort = target.tls ? 443 : 80
  const host = bareHostname(origin.hostname).includes(':') ? `[${bareHostname(origin.hostname)}]` : origin.hostname
  return `${scheme}://${host}${target.port === defaultPort ? '' : `:${target.port}`}`
}

const SYSTEM_STEP_LABELS: Record<string, string> = {
  timezone: 'setting the system time zone',
  mounts: 'mounting the Samba shares',
  driver_setup: 'running display driver setup',
}

/** The Save task's detail line: what the device is doing beyond writing the file. */
export function describeFrameSaveApply(apply: FrameSaveApply | null, movingTo: string | null): string {
  if (!apply) {
    return 'Saved'
  }
  const steps: string[] = []
  if (apply.runtime === 'restart') {
    steps.push('restarting FrameOS to apply the display settings')
  }
  for (const step of apply.system) {
    if (SYSTEM_STEP_LABELS[step]) {
      steps.push(SYSTEM_STEP_LABELS[step])
    }
  }
  if (movingTo) {
    steps.push(`moving to ${movingTo}`)
  }
  return steps.length > 0 ? `Saved, ${steps.join(', ')}` : 'Saved'
}

let followingFrameOrigin = false

/** True while the page is on its way to the frame's new origin, so the unsaved-changes prompt stays quiet. */
export function isFollowingFrameOrigin(): boolean {
  return followingFrameOrigin
}

/** Navigates the current tab to `origin`, keeping the path and query. */
export function followFrameOrigin(origin: string): void {
  followingFrameOrigin = true
  const { pathname, search, hash } = window.location
  window.location.assign(`${origin}${pathname}${search}${hash}`)
}
