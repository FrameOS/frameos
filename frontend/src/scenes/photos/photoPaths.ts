import type { PhotoEntry } from './photosApi'

// Library paths, as docs/photos.md defines them: relative, '/'-separated,
// no leading or trailing slash, the root is ''.

export const PLAYABLE_PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'qoi', 'ppm']
const BROWSER_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'avif']
const MAX_SEGMENT_BYTES = 255

export function photoPathSegments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function joinPhotoPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name
}

export function parentPhotoPath(path: string): string {
  const segments = photoPathSegments(path)
  segments.pop()
  return segments.join('/')
}

export function photoBaseName(path: string): string {
  const segments = photoPathSegments(path)
  return segments[segments.length - 1] ?? ''
}

/** The album a path belongs to: its first segment ('' for the root itself). */
export function photoAlbumOf(path: string): string {
  return photoPathSegments(path)[0] ?? ''
}

/** True when `path` is `folder` or anywhere below it. */
export function isPhotoPathInside(path: string, folder: string): boolean {
  if (!folder) {
    return true
  }
  return path === folder || path.startsWith(folder + '/')
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isPlayablePhotoName(name: string): boolean {
  return PLAYABLE_PHOTO_EXTENSIONS.includes(extensionOf(name))
}

export function isBrowserImageName(name: string): boolean {
  return BROWSER_IMAGE_EXTENSIONS.includes(extensionOf(name))
}

/** Why a new file or folder name is not allowed, or null when it is fine. */
export function photoNameProblem(name: string): string | null {
  if (!name.trim()) {
    return 'Enter a name.'
  }
  if (name === '.' || name === '..' || name.startsWith('.')) {
    return 'Names cannot start with a dot.'
  }
  if (/[/\\]/.test(name)) {
    return 'Names cannot contain / or \\.'
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return 'Names cannot contain control characters.'
  }
  if (new TextEncoder().encode(name).length > MAX_SEGMENT_BYTES) {
    return 'That name is too long.'
  }
  return null
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function comparePhotoNames(a: string, b: string): number {
  return collator.compare(a, b)
}

/** Folders first, then by name the way a file manager sorts ("2" before "10"). */
export function sortPhotoEntries(entries: PhotoEntry[]): PhotoEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'folder' ? -1 : 1
    }
    return comparePhotoNames(a.name, b.name)
  })
}

export function humanFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return ''
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${unit === 0 ? size : size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`
}

export function photoCountLabel(count: number | undefined): string {
  const value = count ?? 0
  return `${value} ${value === 1 ? 'file' : 'files'}`
}
