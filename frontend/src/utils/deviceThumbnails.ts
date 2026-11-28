/**
 * The biggest file a frame that cannot make thumbnails is asked to send for
 * one (undefined: no limit). An ESP32 has no thumbnailer: a row's 32 px
 * picture is the whole file, read off its card and streamed through the one
 * queue its uploads also wait in (docs/cloud-frames.md `asset_get`). A 6 MB
 * phone photo held the bench E1004's uploads up for minutes and failed the
 * files behind it (2026-11-28); such a row shows a picture icon instead, and
 * opening the file still fetches it.
 */
export const ESP32_THUMBNAIL_MAX_BYTES = 1024 * 1024

export function deviceThumbnailMaxBytes(esp32: boolean): number | undefined {
  return esp32 ? ESP32_THUMBNAIL_MAX_BYTES : undefined
}

/** Whether a file of `size` bytes may be asked for as a thumbnail. */
export function thumbnailSizeAllowed(size: number | undefined, maxBytes: number | undefined): boolean {
  return maxBytes === undefined || (size !== undefined && size <= maxBytes)
}
