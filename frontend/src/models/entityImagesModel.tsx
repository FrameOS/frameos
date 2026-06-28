import { actions, connect, kea, listeners, reducers, path, selectors, useValues, useActions } from 'kea'
import { socketLogic } from '../scenes/socketLogic'
import type { entityImagesModelType } from './entityImagesModelType'
import { useEffect, useState } from 'react'
import { getBasePath } from '../utils/getBasePath'
import { projectApiPathFromCache } from '../utils/projectApi'
import { apiFetch } from '../utils/apiFetch'
import { isInFrameAdminMode } from '../utils/frameAdmin'
import type { FrameType } from '../types'

const uploadedScenePrefix = 'uploaded/'

export function useEntityImage(
  entity: string | null,
  subentity: string
): {
  imageUrl: string | null
  isLoading: boolean
  setIsLoading: (loading: boolean) => void
} {
  const { getEntityImage } = useValues(entityImagesModel)
  const { updateEntityImage } = useActions(entityImagesModel)

  const [isLoading, setIsLoading] = useState(true)

  const imageUrl = entity ? getEntityImage(entity, subentity) : null

  useEffect(() => {
    if (entity) {
      updateEntityImage(entity, subentity, false)
    }
  }, [entity, !!imageUrl])

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
  connect(() => ({ logic: [socketLogic] })),
  path(['src', 'models', 'entityImages']),
  actions({
    updateEntityImage: (entity: string | null, subentity: string, force = true) => ({ entity, subentity, force }),
    refreshEntityImageMetadata: (entity: string | null, subentity: string, imageUrl?: string | null) => ({
      entity,
      subentity,
      imageUrl,
    }),
    updateEntityImageTimestamp: (entity: string, subentity: string) => ({ entity, subentity }),
  }),
  reducers(({ values }) => ({
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
      (s) => [s.entityImageTimestamps],
      (entityImageTimestamps) => {
        return (entity: string, subentity: string) => {
          if (!entity) {
            return null
          }

          const timestamp = entityImageTimestamps[entity + '/' + subentity] ?? -1
          return `${getBasePath()}${projectApiPathFromCache(`/api/${entity}/${subentity}`)}?t=${timestamp}`
        }
      },
    ],
  }),
  listeners(({ actions, values }) => ({
    updateEntityImage: async ({ entity, subentity, force }) => {
      if (!entity) {
        return
      }

      if (force) {
        actions.updateEntityImageTimestamp(entity, subentity)
      }
    },
    refreshEntityImageMetadata: async ({ entity, subentity, imageUrl }) => {
      if (!entity || subentity !== 'image') {
        return
      }
      const match = entity.match(/^frames\/(\d+)$/)
      if (!match) {
        return
      }
      const url = imageUrl || values.getEntityImage(entity, subentity)
      if (!url) {
        return
      }
      try {
        const response = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'include' })
        if (!response.ok) {
          return
        }
        const syncChanged = response.headers.get('x-frameos-sync-changed')
        if (syncChanged !== '0' && syncChanged !== '1') {
          return
        }
        socketLogic.actions.updateFrame({
          id: Number(match[1]),
          frame_sync_hint: {
            has_changes: syncChanged === '1',
            checked_at: response.headers.get('x-frameos-sync-checked-at') || new Date().toISOString(),
            current_revision: response.headers.get('x-frameos-sync-revision'),
            deployed_revision: response.headers.get('x-frameos-deployed-revision'),
            frame_config_modified_at: response.headers.get('x-frameos-frame-config-modified-at'),
            scenes_modified_at: response.headers.get('x-frameos-scenes-modified-at'),
            last_successful_deploy_at: response.headers.get('x-frameos-last-successful-deploy-at'),
          },
        } as FrameType)
      } catch (error) {
        console.warn('Failed to refresh frame image metadata', error)
      }
    },
    [socketLogic.actionTypes.newSceneImage]: ({ frameId, sceneId }) => {
      actions.updateEntityImage(`frames/${frameId}`, `scene_images/${sceneId}`)
    },
    [socketLogic.actionTypes.frameRendered]: ({ frameId }) => {
      actions.updateEntityImage(`frames/${frameId}`, 'image')
      if (isInFrameAdminMode()) {
        void (async () => {
          try {
            const response = await apiFetch(`/api/frames/${frameId}/state`)
            if (!response.ok) {
              return
            }
            const payload = await response.json()
            const activeSceneId = typeof payload?.sceneId === 'string' ? payload.sceneId : ''
            const sceneImageId = activeSceneId.startsWith(uploadedScenePrefix)
              ? activeSceneId.slice(uploadedScenePrefix.length)
              : activeSceneId
            if (sceneImageId) {
              actions.updateEntityImage(`frames/${frameId}`, `scene_images/${sceneImageId}`)
            }
          } catch (error) {
            console.error(error)
          }
        })()
      }
    },
  })),
])
