import { actions, afterMount, kea, listeners, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'

import { apiFetch } from '../../utils/apiFetch'
import { Gallery, GalleryImage } from '../../types'

import type { galleryLogicType } from './galleryLogicType'

export const galleryLogic = kea<galleryLogicType>([
  path(['src', 'scenes', 'gallery', 'galleryLogic']),
  actions({
    selectGallery: (id: number | null) => ({ id }),
    updateGallery: ({ id, payload }: { id: number; payload: Partial<Pick<Gallery, 'name' | 'description'>> }) => ({
      id,
      payload,
    }),
  }),
  loaders(({ values, actions }) => ({
    galleries: [
      [] as Gallery[],
      {
        loadGalleries: async () => {
          try {
            const response = await apiFetch('/api/galleries')
            if (!response.ok) {
              throw new Error('Failed to fetch galleries')
            }
            const data = await response.json()
            return data.galleries as Gallery[]
          } catch (error) {
            console.error(error)
            return values.galleries
          }
        },
        createGallery: async ({ name, description }: { name: string; description?: string | null }) => {
          try {
            const response = await apiFetch('/api/galleries', {
              method: 'POST',
              body: JSON.stringify({ name, description }),
              headers: { 'Content-Type': 'application/json' },
            })
            if (!response.ok) {
              throw new Error('Failed to create gallery')
            }
            const gallery = (await response.json()) as Gallery
            const updated = [...values.galleries, gallery]
            actions.selectGallery(gallery.id)
            return updated
          } catch (error) {
            console.error(error)
            return values.galleries
          }
        },
        updateGallery: async ({ id, payload }) => {
          try {
            const response = await apiFetch(`/api/galleries/${id}`, {
              method: 'PATCH',
              body: JSON.stringify(payload),
              headers: { 'Content-Type': 'application/json' },
            })
            if (!response.ok) {
              throw new Error('Failed to update gallery')
            }
            const updatedGallery = (await response.json()) as Gallery
            return values.galleries.map((gallery) => (gallery.id === id ? updatedGallery : gallery))
          } catch (error) {
            console.error(error)
            return values.galleries
          }
        },
        deleteGallery: async ({ id }: { id: number }) => {
          try {
            const response = await apiFetch(`/api/galleries/${id}`, { method: 'DELETE' })
            if (!response.ok && response.status !== 204) {
              throw new Error('Failed to delete gallery')
            }
            const remaining = values.galleries.filter((gallery) => gallery.id !== id)
            if (values.selectedGalleryId === id) {
              actions.selectGallery(remaining.length ? remaining[0].id : null)
            }
            return remaining
          } catch (error) {
            console.error(error)
            return values.galleries
          }
        },
      },
    ],
    imagesByGallery: [
      {} as Record<number, GalleryImage[]>,
      {
        loadImages: async ({ galleryId }: { galleryId: number }) => {
          try {
            const response = await apiFetch(`/api/galleries/${galleryId}/images`)
            if (!response.ok) {
              throw new Error('Failed to fetch gallery images')
            }
            const data = await response.json()
            return { ...values.imagesByGallery, [galleryId]: data.images as GalleryImage[] }
          } catch (error) {
            console.error(error)
            return values.imagesByGallery
          }
        },
        uploadImages: async ({ galleryId, files }: { galleryId: number; files: File[] }) => {
          try {
            const formData = new FormData()
            files.forEach((file) => formData.append('files', file))
            const response = await apiFetch(`/api/galleries/${galleryId}/images`, {
              method: 'POST',
              body: formData,
            })
            if (!response.ok) {
              throw new Error('Failed to upload images')
            }
            const data = await response.json()
            actions.loadGalleries()
            return { ...values.imagesByGallery, [galleryId]: data.images as GalleryImage[] }
          } catch (error) {
            console.error(error)
            return values.imagesByGallery
          }
        },
        removeImage: async ({ galleryId, imageId }: { galleryId: number; imageId: string }) => {
          try {
            const response = await apiFetch(`/api/galleries/${galleryId}/images/${imageId}`, {
              method: 'DELETE',
            })
            if (!response.ok) {
              throw new Error('Failed to delete image')
            }
            const data = await response.json()
            actions.loadGalleries()
            return { ...values.imagesByGallery, [galleryId]: data.images as GalleryImage[] }
          } catch (error) {
            console.error(error)
            return values.imagesByGallery
          }
        },
      },
    ],
  })),
  reducers({
    selectedGalleryId: [
      null as number | null,
      {
        selectGallery: (_, { id }) => id,
      },
    ],
  }),
  selectors({
    selectedGallery: [
      (selectors) => [selectors.galleries, selectors.selectedGalleryId],
      (galleries: Gallery[], selectedId: number | null) =>
        galleries.find((gallery) => gallery.id === selectedId) ?? null,
    ],
    galleryImages: [
      (selectors) => [selectors.imagesByGallery, selectors.selectedGalleryId],
      (imagesByGallery: Record<number, GalleryImage[]>, selectedId: number | null) =>
        selectedId != null ? imagesByGallery[selectedId] ?? [] : [],
    ],
  }),
  listeners(({ actions, values }) => ({
    loadGalleriesSuccess: ({ galleries }) => {
      if (!values.selectedGalleryId && galleries.length) {
        actions.selectGallery(galleries[0].id)
      } else if (values.selectedGalleryId && galleries.every((gallery) => gallery.id !== values.selectedGalleryId)) {
        actions.selectGallery(galleries.length ? galleries[0].id : null)
      }
    },
    selectGallery: ({ id }) => {
      if (id != null) {
        actions.loadImages({ galleryId: id })
      }
    },
  })),
  afterMount(({ actions }) => {
    actions.loadGalleries()
  }),
])
