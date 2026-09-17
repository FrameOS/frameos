/**
 * Is this RGBA pixel buffer one flat colour (or fully transparent)?
 *
 * Old and broken scene saves uploaded a cover before anything was drawn: a
 * valid image, entirely white or black. In a list that reads as a missing
 * picture, so the row shows the placeholder instead. `tolerance` is per
 * channel, enough to see through JPEG noise on a flat fill.
 */
export function pixelsAreBlank(data: ArrayLike<number>, tolerance = 6): boolean {
  if (data.length < 4) {
    return true
  }
  // First opaque pixel seen: everything else is compared against it.
  let first: [number, number, number] | null = null
  for (let i = 0; i + 3 < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < 8) {
      continue
    }
    const pixel: [number, number, number] = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]
    if (!first) {
      first = pixel
      continue
    }
    if (pixel.some((value, channel) => Math.abs(value - (first?.[channel] ?? 0)) > tolerance)) {
      return false
    }
  }
  return true
}

const SAMPLE_SIZE = 16

/** Samples a loaded <img> down to 16×16. False when it cannot tell (cross-origin image, no canvas). */
export function imageElementIsBlank(image: HTMLImageElement): boolean {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE_SIZE
    canvas.height = SAMPLE_SIZE
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context || !image.naturalWidth || !image.naturalHeight) {
      return false
    }
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
    return pixelsAreBlank(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data)
  } catch {
    return false
  }
}
