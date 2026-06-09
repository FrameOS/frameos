import { actions, afterMount, kea, listeners, path } from 'kea'
import { loaders } from 'kea-loaders'

import type { cloudAuthLogicType } from './cloudAuthLogicType'
import { defaultCloudAuthPublicStatus, normalizeCloudAuthPublicStatus } from '../../utils/cloudAuth'
import { getBasePath } from '../../utils/getBasePath'
import { urls } from '../../urls'

export type CloudAuthIntent = 'login' | 'signup'

export const cloudAuthLogic = kea<cloudAuthLogicType>([
  path(['src', 'scenes', 'auth', 'cloudAuthLogic']),
  actions({
    continueWithCloudAuth: (intent: CloudAuthIntent) => ({ intent }),
  }),
  loaders(() => ({
    cloudAuthStatus: [
      defaultCloudAuthPublicStatus as any,
      {
        loadCloudAuthStatus: async (): Promise<any> => {
          try {
            const response = await fetch(`${getBasePath()}/api/cloud-auth/status`, {
              headers: { Accept: 'application/json' },
              credentials: 'include',
            })
            if (!response.ok) {
              return defaultCloudAuthPublicStatus
            }
            return normalizeCloudAuthPublicStatus(await response.json())
          } catch {
            return defaultCloudAuthPublicStatus
          }
        },
      },
    ],
  })),
  listeners(() => ({
    continueWithCloudAuth: ({ intent }) => {
      const redirectTo = urls.frames()
      const callbackOrigin = window.location.origin
      window.location.href = `${getBasePath()}/api/cloud-auth/login?intent=${encodeURIComponent(
        intent
      )}&redirect_to=${encodeURIComponent(redirectTo)}&callback_origin=${encodeURIComponent(callbackOrigin)}`
    },
  })),
  afterMount(({ actions }) => {
    actions.loadCloudAuthStatus()
  }),
])
