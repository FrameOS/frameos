import { afterMount, connect, kea, listeners, path, selectors } from 'kea'
import { loaders } from 'kea-loaders'

import type { cloudDriveLogicType } from './cloudDriveLogicType'
import { RepositoryType, TemplateType } from '../../../../types'
import { apiFetch } from '../../../../utils/apiFetch'
import { isCloudMode } from '../../../../utils/cloudMode'
import { cloudStoreRepository } from '../../../../utils/cloudStoreRepository'
import { getBasePath } from '../../../../utils/getBasePath'
import { cloudLogic } from '../../../settings/cloudLogic'

// The workspace IS the cloud account when running as the cloud control
// plane — the drive index is a same-origin, session-authenticated fetch and
// there is no "link" whose absence could gate anything.
const cloudDriveUrl = '/api/store/account/repository.json'

/** "Private cloud scenes": the account's own FrameOS Cloud store scenes,
 * private ones included. On a self-hosted backend the listing and preview
 * images are proxied with the link token (backend/app/api/cloud_store.py);
 * on the cloud control plane the browser session is the credential and the
 * SPA fetches the drive index directly. Installs go through the normal
 * repository-template flow because the drive is served in the same
 * repository JSON format. Account-level, so one logic for all frames. */
export const cloudDriveLogic = kea<cloudDriveLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Templates', 'cloudDriveLogic']),
  connect({
    values: [cloudLogic, ['grantedScopes', 'cloudProviderUrl', 'cloudStatus']],
    actions: [cloudLogic, ['loadCloudStatusSuccess']],
  }),
  loaders(() => ({
    driveTemplates: [
      [] as TemplateType[],
      {
        loadDrive: async () => {
          if (isCloudMode()) {
            const response = await apiFetch(cloudDriveUrl)
            if (!response.ok) {
              throw new Error('Failed to load your cloud scenes')
            }
            return cloudStoreRepository('system-cloud-drive', cloudDriveUrl, await response.json()).templates ?? []
          }
          const response = await apiFetch('/api/cloud/store/drive')
          if (!response.ok) {
            throw new Error('Failed to load private cloud scenes')
          }
          const payload = await response.json()
          return ((payload?.templates ?? []) as TemplateType[]).map((template) => ({
            ...template,
            // Preview images come through our authenticated backend proxy.
            image:
              typeof template.image === 'string' && template.image.startsWith('/')
                ? getBasePath() + template.image
                : template.image,
          }))
        },
      },
    ],
  })),
  selectors({
    hasDriveScope: [
      (s) => [s.grantedScopes],
      (grantedScopes): boolean => isCloudMode() || grantedScopes.includes('store:publish'),
    ],
    cloudConnected: [
      (s) => [s.cloudStatus],
      (cloudStatus): boolean => isCloudMode() || Boolean(cloudStatus?.link),
    ],
    // FRAMEOS_CLOUD_URL=disabled hides the cloud feature everywhere; don't
    // advertise a settings section that does not exist. Meaningless on the
    // cloud itself.
    cloudEnabled: [
      (s) => [s.cloudStatus],
      (cloudStatus): boolean => isCloudMode() || !cloudStatus || cloudStatus.enabled !== false,
    ],
    driveRepository: [
      (s) => [s.cloudProviderUrl],
      (cloudProviderUrl): RepositoryType =>
        isCloudMode()
          ? {
              id: 'system-cloud-drive',
              name: 'My cloud scenes',
              url: cloudDriveUrl,
              templates: [],
            }
          : {
              id: 'cloud-drive',
              name: 'Private cloud scenes',
              url: `${(cloudProviderUrl ?? '').replace(/\/+$/, '')}/api/store/account/repository.json`,
              templates: [],
            },
    ],
  }),
  listeners(({ actions, values }) => ({
    loadCloudStatusSuccess: () => {
      if (values.hasDriveScope) {
        actions.loadDrive()
      }
    },
  })),
  afterMount(({ actions, values }) => {
    if (values.hasDriveScope) {
      actions.loadDrive()
    }
  }),
])
