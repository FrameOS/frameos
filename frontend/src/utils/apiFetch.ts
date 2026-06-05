import { router } from 'kea-router'
import { inHassioIngress } from './inHassioIngress'
import { getBasePath } from './getBasePath'
import { urls } from '../urls'
import { isFrameControlMode } from './frameControlMode'
import { isInFrameAdminMode } from './frameAdmin'
import { clearCachedProjectId, projectApiPath } from './projectApi'

export interface ApiFetchOptions extends RequestInit {}

export type FirstUserStatus = 'exists' | 'missing' | 'unknown'

export async function firstUserStatus(): Promise<FirstUserStatus> {
  if (isFrameControlMode()) {
    return 'missing'
  }
  try {
    const resp = await fetch(`${getBasePath()}/api/has_first_user`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    if (!resp.ok) {
      return 'unknown'
    }
    const json = await resp.json()
    if (json.has_first_user === true) {
      return 'exists'
    }
    if (json.has_first_user === false) {
      return 'missing'
    }
    return 'unknown'
  } catch (error) {
    console.error('Error checking if user exists:', error)
    return 'unknown'
  }
}

export async function userExists(): Promise<boolean> {
  return (await firstUserStatus()) === 'exists'
}

function routeToAuthStatus(status: FirstUserStatus): Promise<never> {
  router.actions.push(
    status === 'exists' ? urls.login() : status === 'missing' ? urls.signup() : urls.setupUnavailable()
  )
  return new Promise(() => {})
}

export async function apiFetch(input: RequestInfo | URL, options: ApiFetchOptions = {}): Promise<Response> {
  const frameControlMode = isFrameControlMode()
  const inFrameAdminMode = isInFrameAdminMode()
  const headers: HeadersInit = options.headers || {}

  if (typeof input === 'string') {
    try {
      input = await projectApiPath(input)
    } catch (error) {
      if (!inHassioIngress() && !frameControlMode) {
        clearCachedProjectId()
        return routeToAuthStatus(await firstUserStatus())
      }
      throw error
    }
    if (getBasePath() && input.startsWith('/')) {
      input = getBasePath() + input
    }
  }

  const response = await fetch(input, { ...options, headers, credentials: options.credentials || 'include' })

  if (!inHassioIngress() && response.status === 401) {
    if (frameControlMode && inFrameAdminMode) {
      window.location.replace('/login')
      return new Promise(() => {})
    }

    if (!frameControlMode) {
      const status = await firstUserStatus()
      clearCachedProjectId()
      return routeToAuthStatus(status)
    }
  }

  return response
}
