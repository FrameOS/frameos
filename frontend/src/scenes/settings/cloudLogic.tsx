import { actions, afterMount, kea, listeners, path, reducers, selectors } from 'kea'
import { forms } from 'kea-forms'
import { loaders } from 'kea-loaders'

import { CloudStatus } from '../../types'
import { apiFetch } from '../../utils/apiFetch'

import type { cloudLogicType } from './cloudLogicType'

export interface CloudProviderForm {
  provider_url: string
}

async function cloudErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json()
    if (typeof payload?.detail === 'string') {
      return payload.detail
    }
  } catch {
    // Use fallback below.
  }
  return fallback
}

/** Drives the "FrameOS Cloud" settings section, both on the backend and in the
 * on-device frame admin — the /api/cloud/* endpoints exist on both servers. */
export const cloudLogic = kea<cloudLogicType>([
  path(['src', 'scenes', 'settings', 'cloudLogic']),
  actions({
    connectCloud: true,
    pollCloud: true,
    disconnectCloud: true,
    setProviderEditorOpen: (open: boolean) => ({ open }),
    setCloudError: (error: string | null) => ({ error }),
  }),
  loaders(({ actions }) => ({
    cloudStatus: [
      null as CloudStatus | null,
      {
        loadCloudStatus: async () => {
          const response = await apiFetch('/api/cloud/status')
          if (!response.ok) {
            throw new Error(await cloudErrorMessage(response, 'Failed to load FrameOS Cloud status'))
          }
          return (await response.json()) as CloudStatus
        },
      },
    ],
  })),
  reducers({
    providerEditorOpen: [
      false,
      {
        setProviderEditorOpen: (_, { open }) => open,
        submitProviderUrlSuccess: () => false,
      },
    ],
    cloudError: [
      null as string | null,
      {
        setCloudError: (_, { error }) => error,
        connectCloud: () => null,
        disconnectCloud: () => null,
        loadCloudStatus: () => null,
      },
    ],
    isCloudConnecting: [
      false,
      {
        connectCloud: () => true,
        loadCloudStatusSuccess: () => false,
        setCloudError: () => false,
      },
    ],
    isCloudDisconnecting: [
      false,
      {
        disconnectCloud: () => true,
        loadCloudStatusSuccess: () => false,
        setCloudError: () => false,
      },
    ],
  }),
  forms(({ actions }) => ({
    providerUrl: {
      defaults: { provider_url: '' } as CloudProviderForm,
      errors: (form: Partial<CloudProviderForm>) => ({
        provider_url: !form.provider_url?.trim() ? 'Enter a server URL' : null,
      }),
      submit: async (form) => {
        const response = await apiFetch('/api/cloud/provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider_url: form.provider_url.trim() }),
        })
        if (!response.ok) {
          actions.setProviderUrlManualErrors({
            provider_url: await cloudErrorMessage(response, 'Failed to update the server URL'),
          })
          return
        }
        actions.loadCloudStatusSuccess((await response.json()) as CloudStatus)
      },
    },
  })),
  selectors({
    cloudProviderUrl: [
      (s) => [s.cloudStatus],
      (cloudStatus): string => cloudStatus?.provider_url ?? 'https://cloud.frameos.net',
    ],
  }),
  listeners(({ actions, values }) => ({
    connectCloud: async () => {
      const response = await apiFetch('/api/cloud/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!response.ok) {
        actions.setCloudError(await cloudErrorMessage(response, 'Failed to connect to FrameOS Cloud'))
        return
      }
      actions.loadCloudStatusSuccess((await response.json()) as CloudStatus)
    },
    pollCloud: async (_, breakpoint) => {
      if (values.cloudStatus?.status !== 'connecting') {
        return
      }
      const response = await apiFetch('/api/cloud/poll', { method: 'POST' })
      breakpoint()
      if (!response.ok) {
        actions.setCloudError(await cloudErrorMessage(response, 'Failed to poll FrameOS Cloud'))
        return
      }
      actions.loadCloudStatusSuccess((await response.json()) as CloudStatus)
    },
    // Keep polling while the device flow is pending; loadCloudStatusSuccess
    // fires for every status transition, so this self-schedules until the
    // status leaves "connecting" (approval, denial, expiry or disconnect).
    loadCloudStatusSuccess: async ({ cloudStatus }, breakpoint) => {
      if (cloudStatus?.status === 'connecting') {
        await breakpoint((cloudStatus.connection?.interval_seconds ?? 5) * 1000)
        actions.pollCloud()
      }
    },
    disconnectCloud: async () => {
      const response = await apiFetch('/api/cloud/disconnect', { method: 'POST' })
      if (!response.ok) {
        actions.setCloudError(await cloudErrorMessage(response, 'Failed to disconnect from FrameOS Cloud'))
        return
      }
      actions.loadCloudStatusSuccess((await response.json()) as CloudStatus)
    },
    setProviderEditorOpen: ({ open }) => {
      if (open) {
        actions.setProviderUrlValues({ provider_url: values.cloudProviderUrl })
      } else {
        actions.resetProviderUrl()
      }
    },
  })),
  afterMount(({ actions }) => {
    actions.loadCloudStatus()
  }),
])
