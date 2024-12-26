import { actions, connect, kea, listeners, reducers, path, selectors, useValues, useActions } from 'kea'
import { socketLogic } from '../scenes/socketLogic'
import type { entityImagesModelType } from './entityImagesModelType'
import { apiFetch } from '../utils/apiFetch'
import { useEffect, useState } from 'react'

export interface EntityImageInfo {
  url: string
  expiresAt: number
}

export function useEntityImage(entity: string): {
  imageUrl: string | null
  isLoading: boolean
  setIsLoading: (loading: boolean) => void
} {
  const { getEntityImage } = useValues(entityImagesModel)
  const { updateEntityImage } = useActions(entityImagesModel)

  const [isLoading, setIsLoading] = useState(true)

  const imageUrl = getEntityImage(entity)

  useEffect(() => {
    updateEntityImage(entity, false)
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
    updateEntityImage: (entity: string, force = true) => ({ entity, force }),
    setEntityImageInfo: (entity: string, imageInfo: EntityImageInfo) => ({ entity, imageInfo }),
    updateEntityImageTimestamp: (entity: string) => ({ entity }),
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
        updateEntityImageTimestamp: (state, { entity }) => {
          const nowSeconds = Math.floor(Date.now() / 1000)
          // Only update if it's different, to ensure a re-render
          return state[entity] === nowSeconds ? state : { ...state, [entity]: nowSeconds }
        },
      },
    ],
  })),
  selectors({
    getEntityImage: [
      (s) => [s.entityImageInfos, s.entityImageTimestamps],
      (entityImageInfos, entityImageTimestamps) => {
        return (entity: string) => {
          const info = entityImageInfos[entity]
          const now = Math.floor(Date.now() / 1000)
          if (!info || !info.expiresAt || !info.url || now >= info.expiresAt) {
            return null
          }
          const timestamp = entityImageTimestamps[entity] ?? -1
          return `${info.url}${info.url.includes('?') ? '&' : '?'}t=${timestamp}`
        }
      },
    ],
  }),
  listeners(({ actions, values }) => ({
    updateEntityImage: async ({ entity, force }) => {
      // Check if we have a valid URL
      const imageUrl = values.getEntityImage(entity)
      if (imageUrl) {
        // The URL is still valid, no need to refetch new signed URL
        // Just update timestamp to refresh (force reload)
        if (force) {
          actions.updateEntityImageTimestamp(entity)
        }
        return
      }

      // Need a new signed URL
      const resp = await apiFetch(`/api/${entity}/image_link`)
      if (resp.ok) {
        const data = await resp.json()
        const expiresAt = Math.floor(Date.now() / 1000) + data.expires_in
        const imageInfo: EntityImageInfo = { url: data.url, expiresAt }
        actions.setEntityImageInfo(entity, imageInfo)
        // Update timestamp to ensure a new request even if the URL is same
        if (force) {
          actions.updateEntityImageTimestamp(entity)
        }
      } else {
        console.error('Failed to get image link for', entity)
      }
    },
  })),
])
