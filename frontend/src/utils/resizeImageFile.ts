// Resizing images in the browser before they are uploaded ("Resize and
// upload" on Photos and on a frame's Files): the photo is decoded, drawn onto
// a canvas the size it should be and encoded again, and the result goes up
// like any other file. Nothing about it is the server's.
//
// The size is given as a longer and a shorter edge, so one choice suits
// landscape and portrait photos alike: a landscape photo gets a box that is
// `longEdge` wide and `shortEdge` tall, a portrait one the box on its side.

import { exifWithUprightOrientation, readExif, writeExif } from './imageExif'

export type UploadResizeFit = 'cover' | 'inside' | 'contain' | 'fill'
export type UploadResizeFormat = 'keep' | 'jpeg' | 'png' | 'webp'

export interface UploadResizeOptions {
  /** The box's longer edge, in pixels. */
  longEdge: number
  /** The box's shorter edge; null with `inside` limits the longer edge alone. */
  shortEdge: number | null
  fit: UploadResizeFit
  format: UploadResizeFormat
  /** 1–100, for JPEG and WebP. */
  quality: number
  /** Make photos smaller than the box bigger. Off, a smaller photo keeps its size. */
  upscale: boolean
  /** `#rrggbb`: the padding of `contain`, and what is behind transparent parts in a JPEG. */
  background: string
  /**
   * Carry the photo's EXIF block (date taken, camera, GPS location) into the
   * copy. Off, every photo is written again without it, one that already fits
   * included.
   */
  keepMetadata: boolean
}

/** Where the photo goes on the canvas, and the canvas's size. null: the photo stays as it is. */
export interface UploadResizePlan {
  canvasWidth: number
  canvasHeight: number
  /** The photo's rectangle on the canvas (may reach past it, for `cover`). */
  x: number
  y: number
  width: number
  height: number
}

const MAX_SIDE = 16384

function side(value: number): number {
  return Math.max(1, Math.min(MAX_SIDE, Math.round(value)))
}

/**
 * How a photo of `width`×`height` meets the options' box. null when nothing
 * would change, so the original goes up untouched, its metadata included.
 */
export function planUploadResize(
  width: number,
  height: number,
  options: Pick<UploadResizeOptions, 'longEdge' | 'shortEdge' | 'fit' | 'upscale'>
): UploadResizePlan | null {
  if (!(width > 0 && height > 0)) {
    return null
  }
  const long = Math.max(1, options.longEdge)
  const short = options.shortEdge && options.shortEdge > 0 ? options.shortEdge : null
  if (short === null && options.fit !== 'inside') {
    return null
  }
  const landscape = width >= height
  const boxWidth = landscape ? long : (short ?? Infinity)
  const boxHeight = landscape ? (short ?? Infinity) : long
  const fits = width <= boxWidth && height <= boxHeight

  if (options.fit === 'inside') {
    let scale = Math.min(boxWidth / width, boxHeight / height)
    if (!options.upscale) {
      scale = Math.min(scale, 1)
    }
    const w = side(width * scale)
    const h = side(height * scale)
    if (w === width && h === height) {
      return null
    }
    return { canvasWidth: w, canvasHeight: h, x: 0, y: 0, width: w, height: h }
  }

  // Not enlarging: the box shrinks to what the photo has, as a crop (cover),
  // padding (contain) or a squeeze (fill) of the photo at its own size at most.
  const targetWidth = side(options.upscale ? boxWidth : Math.min(boxWidth, width))
  const targetHeight = side(options.upscale ? boxHeight : Math.min(boxHeight, height))
  if (!options.upscale && fits && options.fit !== 'contain') {
    return null
  }

  if (options.fit === 'fill') {
    return {
      canvasWidth: targetWidth,
      canvasHeight: targetHeight,
      x: 0,
      y: 0,
      width: targetWidth,
      height: targetHeight,
    }
  }
  if (options.fit === 'cover') {
    const scale = Math.max(targetWidth / width, targetHeight / height)
    const w = width * scale
    const h = height * scale
    return {
      canvasWidth: targetWidth,
      canvasHeight: targetHeight,
      x: (targetWidth - w) / 2,
      y: (targetHeight - h) / 2,
      width: w,
      height: h,
    }
  }
  // contain: the whole photo in the box, the rest the background.
  const canvasWidth = side(boxWidth)
  const canvasHeight = side(boxHeight)
  let scale = Math.min(canvasWidth / width, canvasHeight / height)
  if (!options.upscale) {
    scale = Math.min(scale, 1)
  }
  const w = width * scale
  const h = height * scale
  return {
    canvasWidth,
    canvasHeight,
    x: (canvasWidth - w) / 2,
    y: (canvasHeight - h) / 2,
    width: w,
    height: h,
  }
}

const ENCODABLE: Record<string, Exclude<UploadResizeFormat, 'keep'>> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
}

const EXTENSIONS: Record<Exclude<UploadResizeFormat, 'keep'>, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' }

/** What a photo of `type` is written as: its own format when a browser can write it, else JPEG. */
export function uploadResizeOutputFormat(
  type: string,
  format: UploadResizeFormat
): Exclude<UploadResizeFormat, 'keep'> {
  if (format !== 'keep') {
    return format
  }
  return ENCODABLE[type.toLowerCase()] ?? 'jpeg'
}

/** The file's name with the extension of the format it was written as (unchanged when it already fits). */
export function uploadResizeFileName(name: string, output: Exclude<UploadResizeFormat, 'keep'>): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const fits = output === 'jpeg' ? extension === 'jpg' || extension === 'jpeg' : extension === EXTENSIONS[output]
  return fits ? name : `${base}.${EXTENSIONS[output]}`
}

/** Whether a file is something the browser may be able to decode as a picture. */
export function isResizableImage(file: File): boolean {
  return /^image\//i.test(file.type) && !/svg/i.test(file.type)
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The browser could not encode the image'))),
      type,
      quality
    )
  })
}

/**
 * Draw `source` at `width`×`height`, halving first while it is more than twice
 * as large: one big step down skips pixels and the result shimmers.
 */
function stepDown(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number) {
  let current: CanvasImageSource = source
  let currentWidth = sourceWidth
  let currentHeight = sourceHeight
  while (currentWidth / 2 >= width && currentHeight / 2 >= height) {
    const next = document.createElement('canvas')
    next.width = Math.max(1, Math.round(currentWidth / 2))
    next.height = Math.max(1, Math.round(currentHeight / 2))
    const context = next.getContext('2d')
    if (!context) {
      break
    }
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(current, 0, 0, next.width, next.height)
    current = next
    currentWidth = next.width
    currentHeight = next.height
  }
  return { image: current, width: currentWidth, height: currentHeight }
}

/**
 * The file resized by `options`, or the file itself when it needs no change.
 * Throws when the browser cannot decode it (HEIC outside Safari, a broken file).
 */
export async function resizeImageFile(file: File, options: UploadResizeOptions): Promise<File> {
  // EXIF orientation applied: the photo is drawn the way up it is seen.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const output = uploadResizeOutputFormat(file.type, options.format)
    const sameFormat = ENCODABLE[file.type.toLowerCase()] === output
    // Written again at its own size: another format, or its metadata to go.
    const plan =
      planUploadResize(bitmap.width, bitmap.height, options) ??
      (sameFormat && options.keepMetadata
        ? null
        : {
            canvasWidth: bitmap.width,
            canvasHeight: bitmap.height,
            x: 0,
            y: 0,
            width: bitmap.width,
            height: bitmap.height,
          })
    if (!plan) {
      return file
    }
    const canvas = document.createElement('canvas')
    canvas.width = plan.canvasWidth
    canvas.height = plan.canvasHeight
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('The browser has no canvas to resize with')
    }
    if (options.fit === 'contain' || output === 'jpeg') {
      context.fillStyle = /^#[0-9a-fA-F]{6}$/.test(options.background) ? options.background : '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
    const stepped = stepDown(bitmap, bitmap.width, bitmap.height, Math.abs(plan.width), Math.abs(plan.height))
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(stepped.image, 0, 0, stepped.width, stepped.height, plan.x, plan.y, plan.width, plan.height)
    const type = `image/${output}`
    const quality = output === 'png' ? undefined : Math.max(0.01, Math.min(1, options.quality / 100))
    const blob = await canvasToBlob(canvas, type, quality)
    let body: Blob = blob
    if (options.keepMetadata) {
      const exif = readExif(new Uint8Array(await file.arrayBuffer()))
      if (exif) {
        const encoded = new Uint8Array(await blob.arrayBuffer())
        body = new Blob([writeExif(encoded, exifWithUprightOrientation(exif), canvas.width, canvas.height)], {
          type: blob.type || type,
        })
      }
    }
    return new File([body], uploadResizeFileName(file.name, output), {
      type: blob.type || type,
      lastModified: file.lastModified,
    })
  } finally {
    bitmap.close()
  }
}
