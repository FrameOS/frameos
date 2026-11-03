import type { FrameOSSettings } from '../types'
import { inHassioIngress } from './inHassioIngress'

export type BackendScheme = '' | 'http' | 'https'

/** A backend address split the way every plane splits one
 * (docs/server-address-fixtures.json; the backend's
 * app/utils/server_address.py, the runtime's types.nim). */
export interface BackendAddressParts {
  /** '' when the address did not say (a bare `host:port` setting). */
  scheme: BackendScheme
  host: string
  /** '' when the address did not say. */
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

/** "host", "host:8989", "https://host:8443/x", "[fd00::10]:8989" → parts. A
 * path is dropped; a port that is not a number (`user:pw@host`) and a scheme
 * other than http(s) stay in the host, so a host check refuses the whole
 * thing. Not the URL parser, which would eat a `:443` or `:80` the owner
 * wrote on purpose. */
export function splitServerAddress(value: unknown): BackendAddressParts {
  let text = trimSettingValue(value)
  let scheme: BackendScheme = ''
  const schemeMatch = text.match(/^([a-z][a-z0-9+.-]*):\/\//i)
  if (schemeMatch) {
    const typed = (schemeMatch[1] ?? '').toLowerCase()
    if (typed !== 'http' && typed !== 'https') {
      return { scheme: '', host: text, port: '' }
    }
    scheme = typed
    text = text.slice(schemeMatch[0].length)
  }
  text = text.replace(/\/.*$/, '').trim()
  if (text.startsWith('[')) {
    const match = text.match(/^(\[[^\]]+\])(?::([0-9]+))?$/)
    if (match) {
      return { scheme, host: match[1] ?? '', port: match[2] ?? '' }
    }
    return { scheme, host: text, port: '' }
  }
  const firstColon = text.indexOf(':')
  if (firstColon > -1 && firstColon === text.lastIndexOf(':')) {
    const portText = text.slice(firstColon + 1)
    if (portText === '' || /^[0-9]+$/.test(portText)) {
      return { scheme, host: text.slice(0, firstColon), port: portText }
    }
  }
  return { scheme, host: text, port: '' }
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
  const configured = splitServerAddress(settings?.defaults?.backendHost)
  const configuredPort = trimSettingValue(settings?.defaults?.backendPort)
  const host = configured.host || fallback.host
  const port = configuredPort || configured.port || fallback.port
  let scheme: BackendScheme = configured.scheme
  if (!scheme && (!configured.host || port === fallback.port)) {
    scheme = fallback.scheme
  }
  return joinAddress(scheme, host, port)
}
