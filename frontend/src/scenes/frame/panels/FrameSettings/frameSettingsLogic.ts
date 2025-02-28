import { kea, key, path, props } from 'kea'

import type { frameSettingsLogicType } from './frameSettingsLogicType'
import { loaders } from 'kea-loaders'
import { apiFetch } from '../../../../utils/apiFetch'

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
    piImageBuild: [
      false,
      {
        buildPiImage: async () => {
          if (confirm('Are you sure you want to build the Pi image?')) {
            try {
              await apiFetch(`/api/frames/${props.frameId}/build_pi_image`, { method: 'POST' })
            } catch (error) {
              console.error(error)
            }
          }
          return false
        },
      },
    ],
  })),
])
