import { afterMount, connect, kea, listeners, path, selectors } from 'kea'
import { loaders } from 'kea-loaders'

import type { cloudDriveLogicType } from './cloudDriveLogicType'
import { RepositoryType, TemplateType } from '../../../../types'
import { apiFetch } from '../../../../utils/apiFetch'
import { getBasePath } from '../../../../utils/getBasePath'
import { cloudLogic } from '../../../settings/cloudLogic'

/** "My cloud drive": the account's own FrameOS Cloud store scenes, private
 * ones included. The backend proxies the listing and preview images with the
 * link token (see backend/app/api/cloud_store.py); installs go through the
 * normal repository-template flow because the drive is served in the same
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
          const response = await apiFetch('/api/cloud/store/drive')
          if (!response.ok) {
            throw new Error('Failed to load cloud drive')
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
    hasDriveScope: [(s) => [s.grantedScopes], (grantedScopes): boolean => grantedScopes.includes('store:publish')],
    cloudConnected: [(s) => [s.cloudStatus], (cloudStatus): boolean => Boolean(cloudStatus?.link)],
    driveRepository: [
      (s) => [s.cloudProviderUrl],
      (cloudProviderUrl): RepositoryType => ({
        id: 'cloud-drive',
        name: 'My cloud drive',
        url: `${(cloudProviderUrl ?? '').replace(/\/+$/, '')}/api/store/account/repository.json`,
        templates: [],
      }),
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
