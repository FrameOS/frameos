// What a photo's metadata says, in words: the viewer's Info panel, the
// location pin and the selection bar's remove buttons (docs/photos.md,
// "Metadata"). Pure helpers; the shared-spa tests pin them.
import type {
  PhotoEntry,
  PhotoLocation,
  PhotoMetadata,
  PhotoMetadataBlock,
  PhotoMetadataField,
  PhotoMetadataRemoval,
  PhotoMetadataValue,
} from './photosApi'
import { photoBaseName } from './photoPaths'

/** The types the server reads and removes metadata from; anything else is left as it is. */
const METADATA_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const METADATA_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp']

/** A JPEG, PNG or WebP photo that is not blocked: what "Remove metadata" can change. */
export function canHoldMetadata(entry: PhotoEntry): boolean {
  if (entry.kind !== 'file' || entry.status === 'blocked') {
    return false
  }
  if (entry.content_type) {
    return METADATA_CONTENT_TYPES.includes(entry.content_type.toLowerCase())
  }
  const dot = entry.name.lastIndexOf('.')
  return dot > 0 && METADATA_EXTENSIONS.includes(entry.name.slice(dot + 1).toLowerCase())
}

export function formatCoordinates(location: PhotoLocation): string {
  return `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`
}

export function formatAltitude(altitude: number): string {
  return `${Number(altitude.toFixed(1))} m`
}

export function openStreetMapUrl(location: PhotoLocation): string {
  const lat = location.latitude.toFixed(5)
  const lon = location.longitude.toFixed(5)
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`
}

function formatNumber(value: number): string {
  // A rational like 1/60 arrives as 0.016666666666666666.
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))
}

export function formatMetadataValue(value: PhotoMetadataValue): string {
  if (Array.isArray(value)) {
    return value.map((item) => formatMetadataValue(item)).join(', ')
  }
  if (value === null) {
    return 'unknown'
  }
  return typeof value === 'number' ? formatNumber(value) : value
}

export interface PhotoMetadataGroup {
  group: string
  label: string
  fields: { name: string; value: string }[]
}

// The decoded coordinates head the panel as "Location"; the raw GPS tags
// under them get their own name.
const GROUP_LABELS: Record<string, string> = { Location: 'GPS' }

/** The fields by group, groups and fields in the server's order. */
export function metadataGroups(fields: PhotoMetadataField[]): PhotoMetadataGroup[] {
  const groups: PhotoMetadataGroup[] = []
  for (const field of fields) {
    let group = groups.find((item) => item.group === field.group)
    if (!group) {
      group = { group: field.group, label: GROUP_LABELS[field.group] ?? field.group, fields: [] }
      groups.push(group)
    }
    group.fields.push({ name: field.name, value: formatMetadataValue(field.value) })
  }
  return groups
}

const BLOCK_WORDS: Record<PhotoMetadataBlock, string> = {
  exif: 'EXIF data',
  xmp: 'XMP data',
  iptc: 'IPTC data',
  comment: 'a comment',
  text: 'text notes',
  other: 'other embedded data',
  trailer: 'a video or second image after the photo',
}

/** One plain sentence naming what the file holds besides the fields listed, or null. */
export function metadataBlocksSentence(metadata: PhotoMetadata): string | null {
  const exifFields = metadata.fields.some((field) => field.group !== 'Text')
  const textFields = metadata.fields.some((field) => field.group === 'Text')
  // EXIF and PNG text are listed field by field; they are named only when none came through.
  const named = metadata.blocks.filter((block) =>
    block === 'exif' ? !exifFields : block === 'text' ? !textFields : true
  )
  // The trailer goes last, where the clause about its own location reads after it.
  const ordered = [...named.filter((block) => block !== 'trailer'), ...named.filter((block) => block === 'trailer')]
  if (!ordered.length) {
    return null
  }
  const words = ordered.map((block) => BLOCK_WORDS[block])
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
  const also = metadata.fields.length > 0 || !!metadata.location ? 'also holds' : 'holds'
  const trailer = ordered.includes('trailer') ? ', which can carry its own location' : ''
  return `This file ${also} ${list}${trailer}.`
}

export function metadataIsEmpty(metadata: PhotoMetadata): boolean {
  return !metadata.location && !metadata.fields.length && !metadata.blocks.length
}

/** Whether "Remove all metadata" would take anything out: it keeps the orientation. */
export function metadataHasRemovable(metadata: PhotoMetadata): boolean {
  return (
    metadata.blocks.some((block) => block !== 'exif') ||
    metadata.fields.some((field) => !(field.group === 'Image' && field.name === 'Orientation'))
  )
}

/** The confirmation before a removal, for one photo or many. */
export function metadataRemovalRequest(
  remove: PhotoMetadataRemoval,
  paths: string[]
): { title: string; message: string; confirmLabel: string } {
  const one = paths.length === 1
  const label = one ? `"${photoBaseName(paths[0])}"` : `${paths.length} photos`
  const file = one ? 'the file' : 'each file'
  if (remove === 'location') {
    return {
      title: `Remove the location from ${label}?`,
      message: `The coordinates are erased from ${file}. Everything else stays. This cannot be undone.`,
      confirmLabel: 'Remove location',
    }
  }
  return {
    title: `Remove all metadata from ${label}?`,
    message: `EXIF, XMP, comments and anything stored after the image, like a motion photo's video, are removed from ${file}. The picture and its orientation stay. This cannot be undone.`,
    confirmLabel: 'Remove metadata',
  }
}

export function metadataRemovalNotice(remove: PhotoMetadataRemoval, changed: number): string {
  const photos = changed === 1 ? '1 photo' : `${changed} photos`
  if (remove === 'location') {
    return changed ? `Removed the location from ${photos}.` : 'There was no location to remove.'
  }
  return changed ? `Removed the metadata from ${photos}.` : 'There was no metadata to remove.'
}
