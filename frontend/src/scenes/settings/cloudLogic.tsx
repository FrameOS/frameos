import { actions, afterMount, kea, listeners, path, reducers, selectors } from 'kea'
import { forms } from 'kea-forms'
import { loaders } from 'kea-loaders'

import { CloudBackupItem, CloudStatus } from '../../types'
import { apiFetch } from '../../utils/apiFetch'
import { isInFrameAdminMode } from '../../utils/frameAdmin'
import { inHassioIngress } from '../../utils/inHassioIngress'
import { getCurrentProjectId } from '../../utils/projectApi'

import type { cloudLogicType } from './cloudLogicType'

export interface CloudProviderForm {
  provider_url: string
}

/** The features a link can enable, in the wording the consent screen uses.
 * Kept in sync with the scope table in CLOUD-TODO.md. */
export const CLOUD_FEATURES: { scope: string; label: string; description: string }[] = [
  {
    scope: 'auth:login',
    label: 'Cloud login',
    description: 'Sign in to this FrameOS with your cloud account',
  },
  {
    scope: 'backup:templates',
    label: 'Template backups',
    description: 'Backup scenes into the cloud',
  },
  {
    scope: 'backup:frames',
    label: 'Frame backups',
    description: 'Back up frame settings + scenes automatically after each deploy',
  },
  {
    scope: 'store:publish',
    label: 'Store publishing',
    description: 'Publish scenes from this FrameOS to the FrameOS Cloud store',
  },
]

const FEATURE_SCOPES = CLOUD_FEATURES.map(({ scope }) => scope)

/** The features this runtime can offer. Home Assistant ingress has no login
 * of its own (Home Assistant authenticates the user), so there is no
 * cloud-login permission to ask for or receive there. */
export function availableCloudFeatures(): typeof CLOUD_FEATURES {
  return inHassioIngress() ? CLOUD_FEATURES.filter(({ scope }) => scope !== 'auth:login') : CLOUD_FEATURES
}

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
    toggleEnabledFeature: (scope: string) => ({ scope }),
    setFeatureDraft: (draft: string[] | null) => ({ draft }),
    applyFeatureChanges: true,
    cancelFeatureChange: true,
    resetFeatureDraft: true,
    linkCloudIdentity: true,
    unlinkCloudIdentity: true,
    setLocalFallback: (enabled: boolean) => ({ enabled }),
    loadCloudBackups: true,
    backupAllToCloud: true,
    restoreCloudBackup: (backupId: string) => ({ backupId }),
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
    cloudBackups: [
      null as CloudBackupItem[] | null,
      {
        loadCloudBackups: async () => {
          const response = await apiFetch('/api/cloud/backups')
          if (!response.ok) {
            actions.setCloudError(await cloudErrorMessage(response, 'Failed to list cloud backups'))
            return null
          }
          const payload = await response.json()
          return (payload.backups ?? []) as CloudBackupItem[]
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
        backupAllToCloud: () => null,
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
    // Staged (unapplied) feature set while connected; null mirrors what is
    // currently granted. applyFeatureChanges submits it.
    featureDraft: [
      null as string[] | null,
      {
        setFeatureDraft: (_, { draft }) => draft,
        resetFeatureDraft: () => null,
        disconnectCloud: () => null,
      },
    ],
    isFeatureChangeSubmitting: [
      false,
      {
        applyFeatureChanges: () => true,
        loadCloudStatusSuccess: () => false,
        setCloudError: () => false,
      },
    ],
    isCloudBackupRunning: [
      false,
      {
        backupAllToCloud: () => true,
        loadCloudBackupsSuccess: () => false,
        setCloudError: () => false,
      },
    ],
    restoringBackupId: [
      null as string | null,
      {
        restoreCloudBackup: (_, { backupId }) => backupId,
        loadCloudBackupsSuccess: () => null,
        setCloudError: () => null,
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
    grantedFeatures: [
      (s) => [s.grantedScopes],
      (scopes): string[] => scopes.filter((scope) => FEATURE_SCOPES.includes(scope)),
    ],
    enabledFeatureDraft: [
      (s) => [s.featureDraft, s.grantedFeatures],
      (featureDraft, grantedFeatures): string[] => featureDraft ?? grantedFeatures,
    ],
    featureChangesPending: [
      (s) => [s.featureDraft, s.grantedFeatures],
      (featureDraft, grantedFeatures): boolean =>
        featureDraft !== null &&
        (featureDraft.length !== grantedFeatures.length ||
          featureDraft.some((scope) => !grantedFeatures.includes(scope))),
    ],
    featureUpgradePending: [(s) => [s.cloudStatus], (cloudStatus): boolean => Boolean(cloudStatus?.upgrade)],
    hasBackupScope: [
      (s) => [s.grantedScopes],
      (scopes): boolean => scopes.includes('backup:templates') || scopes.includes('backup:frames'),
    ],
  }),
  listeners(({ actions, values }) => ({
    connectCloud: async () => {
      // Connecting asks for nothing beyond the link itself; features are
      // enabled afterwards. Frames still bundle auth:login (they have no
      // feature manager yet, and cloud login is their one cloud feature).
      const scopes = isInFrameAdminMode() ? ['frame:link', 'auth:login'] : [...BASE_SCOPES]
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
      if (values.cloudStatus?.status !== 'connecting' && !values.cloudStatus?.upgrade) {
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
      } else if (cloudStatus?.upgrade) {
        // A feature change is waiting for approval on the provider.
        await breakpoint((cloudStatus.upgrade.interval_seconds ?? 5) * 1000)
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
    toggleEnabledFeature: ({ scope }) => {
      const current = values.enabledFeatureDraft
      const next = current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope]
      actions.setFeatureDraft(next)
    },
    applyFeatureChanges: async () => {
      const response = await apiFetch('/api/cloud/features', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopes: values.enabledFeatureDraft }),
      })
      if (!response.ok) {
        actions.setCloudError(await cloudErrorMessage(response, 'Failed to change the enabled features'))
        return
      }
      actions.resetFeatureDraft()
      actions.loadCloudStatusSuccess((await response.json()) as CloudStatus)
    },
    cancelFeatureChange: async () => {
      const response = await apiFetch('/api/cloud/features/cancel', { method: 'POST' })
      if (!response.ok) {
        actions.setCloudError(await cloudErrorMessage(response, 'Failed to cancel the feature change'))
        return
      }
      actions.resetFeatureDraft()
      actions.loadCloudStatusSuccess((await response.json()) as CloudStatus)
    },
    linkCloudIdentity: async () => {
      // Browser handoff: the callback returns to /settings with the identity stored.
      const response = await apiFetch('/api/cloud/identity/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ next: window.location.pathname }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.authorization_url) {
        actions.setCloudError(payload.detail || 'Could not start the cloud account link')
        return
      }
      window.location.href = payload.authorization_url
    },
    unlinkCloudIdentity: async () => {
      const response = await apiFetch('/api/cloud/identity/unlink', { method: 'POST' })
      if (!response.ok) {
        actions.setCloudError(await cloudErrorMessage(response, 'Could not unlink the cloud account'))
        return
      }
      actions.loadCloudStatusSuccess((await response.json()) as CloudStatus)
    },
    setLocalFallback: async ({ enabled }) => {
      const response = await apiFetch('/api/cloud/local-fallback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!response.ok) {
        actions.setCloudError(await cloudErrorMessage(response, 'Could not change local password login'))
        return
      }
      actions.loadCloudStatusSuccess((await response.json()) as CloudStatus)
    },
    backupAllToCloud: async () => {
      // Push every frame and template of the current project. Frames are also
      // backed up automatically after each deploy when the scope is granted.
      const failures: string[] = []
      let attempted = 0
      let succeeded = 0

      const backupItems = async (
        items: { id: string | number; name?: string }[],
        kind: 'frame' | 'template',
        endpoint: string,
        idField: 'frame_id' | 'template_id'
      ): Promise<void> => {
        for (const item of items) {
          attempted += 1
          const label = item.name || `${kind} ${item.id}`
          try {
            const response = await apiFetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ [idField]: item.id }),
            })
            if (response.ok) {
              succeeded += 1
            } else {
              failures.push(`${label}: ${await cloudErrorMessage(response, `Could not back up ${kind} ${item.id}`)}`)
            }
          } catch (error) {
            failures.push(`${label}: ${error instanceof Error ? error.message : `Could not back up ${kind}`}`)
          }
        }
      }

      const scopes = values.grantedScopes
      if (scopes.includes('backup:frames')) {
        try {
          const framesResponse = await apiFetch('/api/frames')
          if (!framesResponse.ok) {
            failures.push(await cloudErrorMessage(framesResponse, 'Could not list frames to back up'))
          } else {
            const frames = (await framesResponse.json()).frames ?? []
            await backupItems(frames, 'frame', '/api/cloud/backups/frames', 'frame_id')
          }
        } catch (error) {
          failures.push(error instanceof Error ? error.message : 'Could not list frames to back up')
        }
      }
      if (scopes.includes('backup:templates')) {
        try {
          const templatesResponse = await apiFetch('/api/templates')
          if (!templatesResponse.ok) {
            failures.push(await cloudErrorMessage(templatesResponse, 'Could not list templates to back up'))
          } else {
            const templates = (await templatesResponse.json()) ?? []
            await backupItems(templates, 'template', '/api/cloud/backups/templates', 'template_id')
          }
        } catch (error) {
          failures.push(error instanceof Error ? error.message : 'Could not list templates to back up')
        }
      }

      if (failures.length > 0) {
        const result = attempted > 0 ? `Backed up ${succeeded} of ${attempted} items. ` : ''
        const remaining = failures.length > 3 ? `; plus ${failures.length - 3} more failure(s)` : ''
        actions.setCloudError(`${result}${failures.slice(0, 3).join('; ')}${remaining}`)
      }
      actions.loadCloudBackups()
    },
    restoreCloudBackup: async ({ backupId }) => {
      const projectId = await getCurrentProjectId()
      const response = await apiFetch('/api/cloud/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backup_id: backupId, project_id: projectId }),
      })
      if (!response.ok) {
        actions.setCloudError(await cloudErrorMessage(response, 'Restore failed'))
        return
      }
      actions.loadCloudBackups()
    },
  })),
  afterMount(({ actions }) => {
    actions.loadCloudStatus()
  }),
])
