import { useActions, useMountedLogic, useValues } from 'kea'
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'

import { galleryLogic } from './galleryLogic'
import { Header } from '../../components/Header'
import { Button } from '../../components/Button'
import { Box } from '../../components/Box'
import { TextInput } from '../../components/TextInput'
import { TextArea } from '../../components/TextArea'
import { Spinner } from '../../components/Spinner'
import { router } from 'kea-router'
import { urls } from '../../urls'
import { Select } from '../../components/Select'

export function Gallery() {
  useMountedLogic(galleryLogic)
  const { galleries, galleriesLoading, selectedGallery, selectedGalleryId, galleryImages, imagesByGalleryLoading } =
    useValues(galleryLogic)
  const { selectGallery, createGallery, updateGallery, deleteGallery, uploadImages, removeImage } =
    useActions(galleryLogic)

  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [imageStyle, setImageStyle] = useState<'full' | 'thumbnail'>('full')

  useEffect(() => {
    if (selectedGallery) {
      setEditName(selectedGallery.name || '')
      setEditDescription(selectedGallery.description || '')
    } else {
      setEditName('')
      setEditDescription('')
    }
  }, [selectedGallery?.id])

  const isImagesLoading = useMemo(
    () => !!selectedGalleryId && imagesByGalleryLoading,
    [selectedGalleryId, imagesByGalleryLoading]
  )

  const handleCreateGallery = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = createName.trim()
    if (!name) {
      return
    }
    createGallery({ name, description: createDescription.trim() || null })
    setCreateName('')
    setCreateDescription('')
  }

  const handleUpdateGallery = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedGalleryId) {
      return
    }
    const payload: { name?: string; description?: string | null } = {}
    const trimmedName = editName.trim()
    if (trimmedName) {
      payload.name = trimmedName
    }
    payload.description = editDescription.trim() || null
    updateGallery({ id: selectedGalleryId, payload })
  }

  const handleDeleteGallery = () => {
    if (!selectedGalleryId) {
      return
    }
    if (confirm('Are you sure you want to delete this gallery? This cannot be undone.')) {
      deleteGallery({ id: selectedGalleryId })
    }
  }

  const handleUploadImages = async (files: FileList | null) => {
    if (!selectedGalleryId || !files || files.length === 0) {
      return
    }
    const fileArray = Array.from(files)
    await uploadImages({ galleryId: selectedGalleryId, files: fileArray })
  }

  return (
    <div className="h-full w-full overflow-hidden max-w-screen max-h-screen left-0 top-0 absolute">
      <div className="flex flex-col h-full max-h-full">
        <div className="h-[60px]">
          <Header
            title="FrameOS Gallery"
            right={
              <div className="flex gap-2">
                <Button color="secondary" onClick={() => router.actions.push(urls.frames())}>
                  Frames
                </Button>
                <Button color="secondary" onClick={() => router.actions.push(urls.settings())}>
                  Settings
                </Button>
              </div>
            }
          />
        </div>
        <div className="flex flex-1 overflow-hidden">
          <div className="w-full max-w-xs border-r border-gray-700 overflow-y-auto p-4 space-y-4">
            <Box className="p-3 space-y-3">
              <h2 className="text-sm font-semibold text-white">Create gallery</h2>
              <form className="space-y-2" onSubmit={handleCreateGallery}>
                <TextInput placeholder="Gallery name" value={createName} onChange={setCreateName} required />
                <TextArea
                  placeholder="Description (optional)"
                  value={createDescription}
                  onChange={setCreateDescription}
                  rows={3}
                />
                <Button type="submit" color="secondary" className="w-full">
                  Create
                </Button>
              </form>
            </Box>
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-white px-1">Galleries</h2>
              {galleriesLoading ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : galleries.length ? (
                galleries
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((gallery) => (
                    <Box
                      key={gallery.id}
                      className={clsx(
                        'p-3 space-y-1 cursor-pointer border transition-colors',
                        selectedGalleryId === gallery.id ? 'border-blue-400' : 'border-gray-700 hover:border-blue-500'
                      )}
                      onClick={() => selectGallery(gallery.id)}
                    >
                      <div className="text-sm font-semibold text-white truncate">{gallery.name}</div>
                      <div className="text-xs text-gray-300 truncate">{gallery.description || 'No description'}</div>
                      <div className="text-xs text-gray-400">{gallery.image_count} images</div>
                    </Box>
                  ))
              ) : (
                <div className="text-xs text-gray-400 px-1">No galleries yet.</div>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {selectedGallery ? (
              <>
                <Box className="p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-semibold text-white">{selectedGallery.name}</h2>
                      <p className="text-sm text-gray-300">
                        {selectedGallery.description || 'No description provided.'}
                      </p>
                    </div>
                    <Button color="red" onClick={handleDeleteGallery}>
                      Delete gallery
                    </Button>
                  </div>
                  <form className="grid gap-2 @md:grid-cols-2" onSubmit={handleUpdateGallery}>
                    <div className="@md:col-span-1">
                      <label className="text-xs text-gray-300 mb-1 block">Name</label>
                      <TextInput value={editName} onChange={setEditName} required />
                    </div>
                    <div className="@md:col-span-1">
                      <label className="text-xs text-gray-300 mb-1 block">Description</label>
                      <TextArea value={editDescription} onChange={setEditDescription} rows={3} />
                    </div>
                    <div className="@md:col-span-2 flex justify-end gap-2">
                      <Button type="submit" color="secondary">
                        Save changes
                      </Button>
                    </div>
                  </form>
                </Box>
                <Box className="p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-md font-semibold text-white">Images</h3>
                      <p className="text-xs text-gray-300">Upload new images or manage existing ones.</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-300 uppercase tracking-wide" htmlFor="image-style-select">
                          Style
                        </label>
                        <Select
                          id="image-style-select"
                          value={imageStyle}
                          onChange={(value) => setImageStyle(value as 'full' | 'thumbnail')}
                          options={[
                            { value: 'full', label: 'Full width' },
                            { value: 'thumbnail', label: 'Thumbnail grid' },
                          ]}
                          className="w-40"
                        />
                      </div>
                      <div className="flex items-center">
                        <input
                          ref={fileInputRef}
                          type="file"
                          className="hidden"
                          accept="image/*"
                          multiple
                          onChange={(event) => {
                            handleUploadImages(event.target.files)
                            if (event.target) {
                              event.target.value = ''
                            }
                          }}
                        />
                        <Button color="secondary" onClick={() => fileInputRef.current?.click()}>
                          Upload images
                        </Button>
                      </div>
                    </div>
                  </div>
                  {isImagesLoading ? (
                    <div className="flex justify-center py-8">
                      <Spinner />
                    </div>
                  ) : galleryImages.length ? (
                    <div
                      className={
                        imageStyle === 'thumbnail'
                          ? 'grid gap-3 grid-cols-2 @md:grid-cols-3 @lg:grid-cols-4'
                          : 'grid gap-4 grid-cols-1 @md:grid-cols-2 @lg:grid-cols-3'
                      }
                    >
                      {galleryImages.map((image) => (
                        <Box
                          key={image.id}
                          className={imageStyle === 'thumbnail' ? 'p-1.5 space-y-1.5' : 'p-2 space-y-2'}
                        >
                          <a
                            href={image.original_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block overflow-hidden rounded-lg bg-black"
                          >
                            <img
                              src={
                                imageStyle === 'thumbnail'
                                  ? image.thumbnail_url || image.original_url
                                  : image.original_url
                              }
                              alt={image.filename}
                              className={
                                imageStyle === 'thumbnail'
                                  ? 'w-full aspect-square object-cover'
                                  : 'w-full h-48 object-cover'
                              }
                            />
                          </a>
                          <div
                            className={
                              imageStyle === 'thumbnail'
                                ? 'text-[11px] text-gray-300 truncate'
                                : 'text-xs text-gray-300 truncate'
                            }
                          >
                            {image.filename}
                          </div>
                          <div
                            className={
                              imageStyle === 'thumbnail'
                                ? 'flex justify-between items-center text-[11px] text-gray-400'
                                : 'flex justify-between items-center text-xs text-gray-400'
                            }
                          >
                            <span>
                              {image.width && image.height ? `${image.width}×${image.height}` : 'Unknown size'}
                            </span>
                            <Button
                              color="red"
                              size="small"
                              onClick={() => removeImage({ galleryId: image.gallery_id, imageId: image.id })}
                            >
                              Delete
                            </Button>
                          </div>
                        </Box>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-gray-400">No images yet. Upload some to get started.</div>
                  )}
                </Box>
              </>
            ) : (
              <div className="text-sm text-gray-300">Select a gallery to get started.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Gallery
