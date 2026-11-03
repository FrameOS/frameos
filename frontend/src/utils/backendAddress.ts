import type { FrameOSSettings } from '../types'
import { inHassioIngress } from './inHassioIngress'

export type BackendScheme = '' | 'http' | 'https'

export interface BackendAddressParts {
  /** '' when the address did not say (a bare `host:port` setting). */
  scheme: BackendScheme
  host: string
  port: string
}

function trimSettingValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim()
}

function browserBackendScheme(): BackendScheme {
  if (typeof window === 'undefined') {
    return ''
  }
  if (inHassioIngress()) {
    // The add-on's frames port (8989) is not the connection this browser is
    // on (the Supervisor's ingress proxy): the backend says whether that port
    // serves TLS (`public_scheme`, set by docker-entrypoint.sh from the
    // add-on's ssl option).
    return (window as any).FRAMEOS_APP_CONFIG?.public_scheme === 'https' ? 'https' : 'http'
  }
  return window.location.protocol === 'https:' ? 'https' : 'http'
}

function browserBackendAddressParts(): BackendAddressParts {
  if (typeof window === 'undefined') {
    return { scheme: '', host: '', port: '' }
  }
  const port = inHassioIngress()
    ? '8989'
    : window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
  return { scheme: browserBackendScheme(), host: window.location.hostname, port }
}

function splitScheme(value: unknown): { scheme: BackendScheme; rest: string } {
  const rawValue = trimSettingValue(value)
  const match = rawValue.match(/^([a-z][a-z0-9+.-]*):\/\//i)
  if (!match) {
    return { scheme: '', rest: rawValue }
  }
  const scheme = (match[1] ?? '').toLowerCase()
  return { scheme: scheme === 'http' || scheme === 'https' ? scheme : '', rest: rawValue.slice(match[0].length) }
}

function normalizeHostSetting(value: unknown): { scheme: BackendScheme; host: string } {
  const { scheme, rest } = splitScheme(value)
  // host[:port] as typed, a path dropped; not the URL parser, which would eat
  // a `:443` or `:80` the owner wrote on purpose.
  return { scheme, host: rest.replace(/\/.*$/, '') }
}

function splitHostPort(value?: string | null): BackendAddressParts {
  const { scheme, host: normalized } = normalizeHostSetting(value)
  if (!normalized) {
    return { scheme, host: '', port: '' }
  }
  if (normalized.startsWith('[')) {
    const match = normalized.match(/^\[([^\]]+)\](?::([0-9]+))?$/)
    if (match) {
      return { scheme, host: `[${match[1]}]`, port: match[2] ?? '' }
    }
  }
  const firstColon = normalized.indexOf(':')
  const lastColon = normalized.lastIndexOf(':')
  if (firstColon > -1 && firstColon === lastColon) {
    return { scheme, host: normalized.slice(0, firstColon), port: normalized.slice(lastColon + 1) }
  }
  return { scheme, host: normalized, port: '' }
}

function joinAddress(scheme: BackendScheme, host: string, port: string): string | undefined {
  if (!host) {
    return undefined
  }
  const hostPort = port ? `${host}:${port}` : host
  // http stays implicit (what every frame assumed before the scheme existed);
  // https must be said, or the frame would talk plain HTTP to a TLS port.
  return scheme === 'https' ? `https://${hostPort}` : hostPort
}

export function detectedBackendAddressParts(): BackendAddressParts {
  return browserBackendAddressParts()
}

/** The server address a new frame is prefilled with: Settings → Defaults
 * when set, else the backend this browser reached. The setting may start
 * with `https://`; a bare one takes the detected scheme only when it points
 * at the same port, i.e. this very server. */
export function defaultNewFrameServerHost(settings?: FrameOSSettings): string | undefined {
  const fallback = detectedBackendAddressParts()
  const configured = splitHostPort(settings?.defaults?.backendHost)
  const configuredPort = trimSettingValue(settings?.defaults?.backendPort)
  const host = configured.host || fallback.host
  const port = configuredPort || configured.port || fallback.port
  let scheme: BackendScheme = configured.scheme
  if (!scheme && (!configured.host || port === fallback.port)) {
    scheme = fallback.scheme
  }
  return joinAddress(scheme, host, port)
}
