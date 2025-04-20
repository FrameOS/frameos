import { actions, connect, kea, listeners, reducers, path, selectors, useValues, useActions } from 'kea'
import { socketLogic } from '../scenes/socketLogic'
import type { entityImagesModelType } from './entityImagesModelType'
import { apiFetch } from '../utils/apiFetch'
import { useEffect, useState } from 'react'
import { inHassioIngress } from '../utils/inHassioIngress'
import { getBasePath } from '../utils/getBasePath'

export interface EntityImageInfo {
  token: string
  expiresAt: number
}

export function useEntityImage(
  entity: string,
  subentity: string
): {
  imageUrl: string | null
  isLoading: boolean
  setIsLoading: (loading: boolean) => void
} {
  const { getEntityImage } = useValues(entityImagesModel)
  const { updateEntityImage } = useActions(entityImagesModel)

  const [isLoading, setIsLoading] = useState(true)

  const imageUrl = getEntityImage(entity, subentity)

  useEffect(() => {
    updateEntityImage(entity, subentity, false)
  }, [!!imageUrl])

  useEffect(() => {
    // Whenever the image URL changes, we consider the image as loading again
    // because the <img> will re-attempt to load the new URL.
    if (imageUrl) {
      setIsLoading(true)
    }
  }, [imageUrl])

  return { imageUrl, isLoading, setIsLoading }
}

export const entityImagesModel = kea<entityImagesModelType>([
  connect({ logic: [socketLogic] }),
  path(['src', 'models', 'entityImages']),
  actions({
    updateEntityImage: (entity: string, subentity: string, force = true) => ({ entity, subentity, force }),
    setEntityImageInfo: (entity: string, imageInfo: EntityImageInfo) => ({ entity, imageInfo }),
    updateEntityImageTimestamp: (entity: string, subentity: string) => ({ entity, subentity }),
  }),
  reducers(({ values }) => ({
    entityImageInfos: [
      {} as Record<string, EntityImageInfo>,
      {
        setEntityImageInfo: (state, { entity, imageInfo }) => ({ ...state, [entity]: imageInfo }),
      },
    ],
    entityImageTimestamps: [
      {} as Record<string, number>,
      {
        updateEntityImageTimestamp: (state, { entity, subentity }) => {
          const nowSeconds = Math.floor(Date.now() / 1000)
          // Only update if it's different, to ensure a re-render
          return state[entity + '/' + subentity] === nowSeconds
            ? state
            : { ...state, [entity + '/' + subentity]: nowSeconds }
        },
      },
    ],
  })),
  selectors({
    getEntityImage: [
      (s) => [s.entityImageInfos, s.entityImageTimestamps],
      (entityImageInfos, entityImageTimestamps) => {
        return (entity: string, subentity: string) => {
          if (inHassioIngress()) {
            const timestamp = entityImageTimestamps[entity + '/' + subentity] ?? -1
            return `${getBasePath()}/api/${entity}/${subentity}?token&t=${timestamp}`
          }

          const info = entityImageInfos[entity]
          const now = Math.floor(Date.now() / 1000)
          if (!info || !info.expiresAt || !info.token || now >= info.expiresAt) {
            return null
          }
          const timestamp = entityImageTimestamps[entity + '/' + subentity] ?? -1
          return `${getBasePath()}/api/${entity}/${subentity}?token=${encodeURIComponent(info.token)}&t=${timestamp}`
        }
      },
    ],
  }),
  listeners(({ actions, values }) => ({
    updateEntityImage: async ({ entity, subentity, force }) => {
      // Check if we have a valid URL
      const imageUrl = values.getEntityImage(entity, subentity)
      if (imageUrl) {
        // The URL is still valid, no need to refetch new signed URL
        // Just update timestamp to refresh (force reload)
        if (force) {
          actions.updateEntityImageTimestamp(entity, subentity)
        }
        return
      }

      // Need a new signed URL
      const resp = await apiFetch(`/api/${entity}/image_token`)
      if (resp.ok) {
        const data = await resp.json()
        const expiresAt = Math.floor(Date.now() / 1000) + data.expires_in
        const imageInfo: EntityImageInfo = { token: data.token, expiresAt }
        actions.setEntityImageInfo(entity, imageInfo)
        // Update timestamp to ensure a new request even if the URL is same
        if (force) {
          actions.updateEntityImageTimestamp(entity, subentity)
        }
      } else {
        console.error('Failed to get image link for', entity, subentity)
      }
    },
  })),
])
