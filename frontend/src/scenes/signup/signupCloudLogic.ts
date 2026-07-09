import { actions, afterMount, kea, listeners, path, reducers } from 'kea'
import { loaders } from 'kea-loaders'

import { CloudStatus } from '../../types'
import { getBasePath } from '../../utils/getBasePath'

import type { signupCloudLogicType } from './signupCloudLogicType'

// First-run setup: no user exists yet, so this uses the open
// /api/cloud/setup/* endpoints (they stop working the moment a user exists).
// Once linked with auth:login, cloudLoginLogic's "Continue with FrameOS
// Cloud" creates the first user from the approving cloud account.
const SETUP_SCOPES = ['backend:link', 'backend:read', 'auth:login', 'backup:templates', 'backup:frames']

async function setupFetch(path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`${getBasePath()}${path}`, init)
}

export const signupCloudLogic = kea<signupCloudLogicType>([
  path(['src', 'scenes', 'signup', 'signupCloudLogic']),
  actions({
    connectSetupCloud: true,
    pollSetupCloud: true,
    cancelSetupCloud: true,
    setSetupCloudError: (error: string | null) => ({ error }),
  }),
  loaders({
    setupCloudStatus: [
      null as CloudStatus | null,
      {
        loadSetupCloudStatus: async () => {
          try {
            const response = await setupFetch('/api/cloud/setup/status')
            if (!response.ok) {
              return null // setup already complete, or cloud disabled
            }
            return (await response.json()) as CloudStatus
          } catch {
            return null
          }
        },
      },
    ],
  }),
  reducers({
    setupCloudError: [
      null as string | null,
      {
        setSetupCloudError: (_, { error }) => error,
        connectSetupCloud: () => null,
      },
    ],
    isSetupCloudConnecting: [
      false,
      {
        connectSetupCloud: () => true,
        loadSetupCloudStatusSuccess: () => false,
        setSetupCloudError: () => false,
      },
    ],
  }),
  listeners(({ actions, values }) => ({
    connectSetupCloud: async () => {
      const response = await setupFetch('/api/cloud/setup/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopes: SETUP_SCOPES }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        actions.setSetupCloudError(payload.detail || 'Could not reach FrameOS Cloud')
        return
      }
      actions.loadSetupCloudStatusSuccess((await response.json()) as CloudStatus)
    },
    pollSetupCloud: async () => {
      if (values.setupCloudStatus?.status !== 'connecting') {
        return
      }
      const response = await setupFetch('/api/cloud/setup/poll', { method: 'POST' })
      if (!response.ok) {
        return
      }
      actions.loadSetupCloudStatusSuccess((await response.json()) as CloudStatus)
    },
    loadSetupCloudStatusSuccess: async ({ setupCloudStatus }, breakpoint) => {
      if (setupCloudStatus?.status === 'connecting') {
        await breakpoint((setupCloudStatus.connection?.interval_seconds ?? 5) * 1000)
        actions.pollSetupCloud()
      }
    },
    cancelSetupCloud: async () => {
      const response = await setupFetch('/api/cloud/setup/disconnect', { method: 'POST' })
      if (response.ok) {
        actions.loadSetupCloudStatusSuccess((await response.json()) as CloudStatus)
      }
    },
  })),
  afterMount(({ actions }) => {
    actions.loadSetupCloudStatus()
  }),
])
