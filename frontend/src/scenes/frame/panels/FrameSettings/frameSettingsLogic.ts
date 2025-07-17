import { kea, key, path, props } from 'kea'

import type { frameSettingsLogicType } from './frameSettingsLogicType'
import { loaders } from 'kea-loaders'
import { apiFetch } from '../../../../utils/apiFetch'
import { downloadZip } from '../../../../utils/downloadJson'

export const frameSettingsLogic = kea<frameSettingsLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'FrameSettings', 'frameSettingsLogic']),
  props({} as { frameId: number }),
  key((props) => props.frameId),
  loaders(({ props }) => ({
    buildCache: [
      false,
      {
        clearBuildCache: async () => {
          if (confirm('Are you sure you want to clear the build cache?')) {
            try {
              await apiFetch(`/api/frames/${props.frameId}/clear_build_cache`, { method: 'POST' })
            } catch (error) {
              console.error(error)
            }
          }
          return false
        },
      },
    ],
    buildZip: [
      false,
      {
        downloadBuildZip: async () => {
          const response = await apiFetch(`/api/frames/${props.frameId}/download_build_zip`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
          })
          if (!response.ok) {
            throw new Error('Failed to download build zip')
          }
          downloadZip(await response.blob(), `frame_${props.frameId}_build.zip`)
          return false
        },
      },
    ],
  })),
])
