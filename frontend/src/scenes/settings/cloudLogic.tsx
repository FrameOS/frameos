import { actions, afterMount, kea, listeners, path, reducers, selectors } from 'kea'
import { forms } from 'kea-forms'
import { loaders } from 'kea-loaders'

import { CloudStatus } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { isInFrameAdminMode } from '../../utils/frameAdmin'

import type { cloudLogicType } from './cloudLogicType'

export interface CloudProviderForm {
  provider_url: string
}

/** The features a link can enable, in the wording the consent screen uses.
 * Kept in sync with the scope table in CLOUD-TODO.md.
 *
 * Everything that is safe comes with the cloud account itself and is
 * requested with the link; 'locked' renders an always-on checkbox.
 * Security-sensitive features (cloud login, remote access, ...) will get a
 * cloud-approved opt-in toggle when they ship. */
export const CLOUD_FEATURES: {
  scope: string
  label: string
  description: string
  control: 'locked'
}[] = [
  {
    scope: 'store:publish',
    label: 'Save and share scenes via the cloud',
    description: 'Save scenes to your cloud account and share them on the FrameOS store',
    control: 'locked',
  },
  {
    scope: 'backup:scenes',
    label: 'Scene backups',
    description: 'Back up your scenes into the cloud',
    control: 'locked',
  },
  {
    scope: 'backup:frames',
    label: 'Frame backups',
    description: 'Back up frame settings + scenes automatically after each deploy',
    control: 'locked',
  },
]

/** Scopes that come with every connected cloud account; requested at link time. */
export const INCLUDED_FEATURE_SCOPES = CLOUD_FEATURES.map(({ scope }) => scope)

const BASE_SCOPES = ['backend:link', 'backend:read']

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
  loaders(() => ({
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
    grantedScopes: [(s) => [s.cloudStatus], (cloudStatus): string[] => cloudStatus?.link?.scopes ?? []],
  }),
  listeners(({ actions, values }) => ({
    connectCloud: async () => {
      // Connecting asks for the link plus every included ("safe") feature in
      // one approval.
      const scopes = isInFrameAdminMode() ? ['frame:link'] : [...BASE_SCOPES, ...INCLUDED_FEATURE_SCOPES]
      const response = await apiFetch('/api/cloud/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopes }),
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
