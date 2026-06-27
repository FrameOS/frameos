import type { FrameOSSettings } from '../types'
import { inHassioIngress } from './inHassioIngress'

export interface BackendAddressParts {
  host: string
  port: string
}

function trimSettingValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim()
}

function browserBackendAddress(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  return `${window.location.hostname}:${
    inHassioIngress() ? '8989' : window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
  }`
}

function normalizeHostSetting(value: unknown): string {
  const rawValue = trimSettingValue(value)
  if (!rawValue) {
    return ''
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawValue)) {
    try {
      return new URL(rawValue).host
    } catch {
      return rawValue.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '')
    }
  }
  return rawValue.replace(/\/.*$/, '')
}

function splitHostPort(value?: string | null): BackendAddressParts {
  const normalized = normalizeHostSetting(value)
  if (!normalized) {
    return { host: '', port: '' }
  }
  if (normalized.startsWith('[')) {
    const match = normalized.match(/^\[([^\]]+)\](?::([0-9]+))?$/)
    if (match) {
      return { host: `[${match[1]}]`, port: match[2] ?? '' }
    }
  }
  const firstColon = normalized.indexOf(':')
  const lastColon = normalized.lastIndexOf(':')
  if (firstColon > -1 && firstColon === lastColon) {
    return { host: normalized.slice(0, firstColon), port: normalized.slice(lastColon + 1) }
  }
  return { host: normalized, port: '' }
}

function joinHostPort(host: string, port: string): string | undefined {
  if (!host) {
    return undefined
  }
  return port ? `${host}:${port}` : host
}

export function detectedBackendAddressParts(): BackendAddressParts {
  return splitHostPort(browserBackendAddress())
}

export function defaultNewFrameServerHost(settings?: FrameOSSettings): string | undefined {
  const fallback = detectedBackendAddressParts()
  const configuredHost = splitHostPort(settings?.defaults?.backendHost)
  const configuredPort = trimSettingValue(settings?.defaults?.backendPort)
  return joinHostPort(configuredHost.host || fallback.host, configuredPort || configuredHost.port || fallback.port)
}
