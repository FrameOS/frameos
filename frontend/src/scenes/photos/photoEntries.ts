// Pure helpers over listings (PhotoEntry[] per folder) that the logic and
// the workspace share; the shared-spa tests pin them.
import type { PhotoEntry } from './photosApi'
import { isPlayablePhotoName, joinPhotoPath, parentPhotoPath, photoPathSegments, sortPhotoEntries } from './photoPaths'

export type PhotoThumbnailFit = 'cover' | 'contain'
export type PhotoOrientation = 'portrait' | 'landscape'

/**
 * The listings after one photo was stored, before the server is asked again:
 * the file joins its folder, and every folder above it counts one more file,
 * its bytes, and shows it as the cover. An upload in progress moves an
 * album's cover along with each finished photo; the reload at the end puts
 * the server's own choice back.
 */
export function withUploadedPhoto(
  folderEntries: Record<string, PhotoEntry[]>,
  entry: PhotoEntry
): Record<string, PhotoEntry[]> {
  const next = { ...folderEntries }
  const parent = parentPhotoPath(entry.path)
  const siblings = next[parent]
  const isNew = !siblings?.some((item) => item.path === entry.path)
  if (siblings) {
    next[parent] = sortPhotoEntries([...siblings.filter((item) => item.path !== entry.path), entry])
  }
  const cover = entry.kind === 'file' && isPlayablePhotoName(entry.name) ? entry.path : null
  let folder = ''
  for (const segment of photoPathSegments(parent)) {
    const path = joinPhotoPath(folder, segment)
    const listing = next[folder]
    if (listing) {
      next[folder] = listing.map((item) =>
        item.kind === 'folder' && item.path === path
          ? {
              ...item,
              cover: cover ?? item.cover,
              files: (item.files ?? 0) + (isNew ? 1 : 0),
              items: (item.items ?? 0) + (isNew && path === parent ? 1 : 0),
              size: item.size + entry.size,
            }
          : item
      )
    }
    folder = path
  }
  return next
}

/** The photos in a listing that are taller than wide, or wider than tall (squares are neither). */
export function entriesByOrientation(entries: PhotoEntry[], orientation: PhotoOrientation): PhotoEntry[] {
  return entries.filter(
    (entry) =>
      entry.kind === 'file' &&
      !!entry.width &&
      !!entry.height &&
      (orientation === 'portrait' ? entry.height > entry.width : entry.width > entry.height)
  )
}

/** A rectangle with the photo's aspect ratio, fitted and centred in a square box of `box` px. */
export function aspectMarkRect(
  width: number,
  height: number,
  box: number
): { x: number; y: number; width: number; height: number } {
  const scale = box / Math.max(width, height, 1)
  const w = Math.max(2, Math.round(width * scale))
  const h = Math.max(2, Math.round(height * scale))
  return { x: (box - w) / 2, y: (box - h) / 2, width: w, height: h }
}
