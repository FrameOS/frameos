import { actions, afterMount, kea, listeners, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'

import { CloudLoginOptions } from '../../types'
import { getBasePath } from '../../utils/getBasePath'

import type { cloudLoginLogicType } from './cloudLoginLogicType'

/** "Continue with FrameOS Cloud" on the login and first-run setup screens.
 * Uses only open endpoints (the user is not logged in yet); the same paths
 * exist on the backend and on the frame's on-device admin server. */
export const cloudLoginLogic = kea<cloudLoginLogicType>([
  path(['src', 'scenes', 'auth', 'cloudLoginLogic']),
  actions({
    startCloudLogin: (next?: string) => ({ next: next ?? null }),
    setCloudLoginError: (error: string | null) => ({ error }),
  }),
  loaders({
    cloudLoginOptions: [
      null as CloudLoginOptions | null,
      {
        loadCloudLoginOptions: async () => {
          try {
            const response = await fetch(`${getBasePath()}/api/cloud/login/options`, {
              headers: { Accept: 'application/json' },
            })
            if (!response.ok) {
              return null
            }
            return (await response.json()) as CloudLoginOptions
          } catch {
            return null
          }
        },
      },
    ],
  }),
  reducers({
    cloudLoginError: [
      // The login callback redirects back with ?cloudError=… on failure.
      (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('cloudError') : null) as
        | string
        | null,
      {
        setCloudLoginError: (_, { error }) => error,
        startCloudLogin: () => null,
      },
    ],
    isCloudLoginStarting: [
      false,
      {
        startCloudLogin: () => true,
        setCloudLoginError: () => false,
      },
    ],
  }),
  selectors({
    cloudLoginAvailable: [(s) => [s.cloudLoginOptions], (options): boolean => options?.available ?? false],
    localLoginEnabled: [(s) => [s.cloudLoginOptions], (options): boolean => options?.local_login_enabled ?? true],
  }),
  listeners(({ actions }) => ({
    startCloudLogin: async ({ next }) => {
      try {
        const response = await fetch(`${getBasePath()}/api/cloud/login/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next ? { next } : {}),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || !payload.authorization_url) {
          actions.setCloudLoginError(payload.detail || 'Could not start the FrameOS Cloud login')
          return
        }
        window.location.href = payload.authorization_url
      } catch {
        actions.setCloudLoginError('Could not reach this server to start the FrameOS Cloud login')
      }
    },
  })),
  afterMount(({ actions }) => {
    actions.loadCloudLoginOptions()
  }),
])

export function cloudLoginErrorMessage(error: string): string {
  switch (error) {
    case 'not_linked':
      return 'That FrameOS Cloud account is not linked to a user on this install. Log in locally and link it under Settings → FrameOS Cloud.'
    case 'not_connected':
      return 'This install is not connected to FrameOS Cloud.'
    case 'invalid_state':
      return 'The cloud login expired or was already used. Try again.'
    case 'exchange_failed':
      return 'FrameOS Cloud did not accept the login. Try again.'
    case 'network_error':
      return 'Could not reach the FrameOS Cloud server.'
    case 'access_denied':
      return 'The login was denied in FrameOS Cloud.'
    case 'linked_client_required':
      return 'Only the cloud account that owns this install can log in with FrameOS Cloud.'
    default:
      return `FrameOS Cloud login failed: ${error}`
  }
}
