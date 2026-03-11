import { router } from 'kea-router'
import { inHassioIngress } from './inHassioIngress'
import { getBasePath } from './getBasePath'
import { urls } from '../urls'
import { isFrameControlMode } from './frameControlMode'
import { isInFrameAdminMode } from './frameAdmin'

export interface ApiFetchOptions extends RequestInit {}

export async function userExists(): Promise<boolean> {
  if (isFrameControlMode()) {
    return false
  }
  try {
    const resp = await fetch('/api/has_first_user', { method: 'GET', headers: { Accept: 'application/json' } })
    if (!resp.ok) {
      return false
    }
    const json = await resp.json()
    return json.has_first_user === true
  } catch (error) {
    console.error('Error checking if user exists:', error)
    return false
  }
}

export async function apiFetch(input: RequestInfo | URL, options: ApiFetchOptions = {}): Promise<Response> {
  const frameControlMode = isFrameControlMode()
  const inFrameAdminMode = isInFrameAdminMode()
  const headers: HeadersInit = options.headers || {}

  if (typeof input === 'string' && getBasePath()) {
    input = getBasePath() + input
  }

  const response = await fetch(input, { ...options, headers, credentials: options.credentials || 'include' })

  if (!inHassioIngress() && response.status === 401) {
    if (frameControlMode && inFrameAdminMode) {
      window.location.replace('/login')
      return new Promise(() => {})
    }

    if (!frameControlMode) {
      const exists = await userExists()
      if (exists) {
        router.actions.push(urls.login())
      } else {
        router.actions.push(urls.signup())
      }
      return new Promise(() => {})
    }
  }

  return response
}
