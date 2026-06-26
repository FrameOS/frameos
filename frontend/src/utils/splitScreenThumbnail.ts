import type { FrameType } from '../types'
import { getBasePath } from './getBasePath'
import { projectApiPath } from './projectApi'
import type { SplitScreenSceneLayout } from './splitScreenLayouts'
import { splitLayoutLeafRects } from './splitScreenLayouts'

function frameDisplayDimensions(frame: Pick<FrameType, 'width' | 'height' | 'rotate'>): {
  width: number
  height: number
} {
  const width = frame.width && frame.width > 0 ? frame.width : 800
  const height = frame.height && frame.height > 0 ? frame.height : 480
  return frame.rotate === 90 || frame.rotate === 270 ? { width: height, height: width } : { width, height }
}

function fitCanvasDimensions(width: number, height: number): { width: number; height: number } {
  const maxSide = 720
  const scale = Math.min(1, maxSide / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function imageApiUrl(path: string): string {
  const basePath = getBasePath()
  return path.startsWith('/api/') && basePath ? `${basePath}${path}` : path
}

async function fetchSceneImage(frameId: number, sceneId: string): Promise<HTMLImageElement | null> {
  const apiPath = await projectApiPath(`/api/frames/${frameId}/scene_images/${sceneId}`)
  const imageUrl = `${imageApiUrl(apiPath)}?thumb=1&t=${Date.now()}`
  const response = await fetch(imageUrl, { credentials: 'include' })
  if (!response.ok) {
    return null
  }

  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const image = new Image()
  return await new Promise<HTMLImageElement | null>((resolve) => {
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = objectUrl
  }).finally(() => {
    URL.revokeObjectURL(objectUrl)
  })
}

function drawCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  const sourceRatio = image.naturalWidth / image.naturalHeight
  const targetRatio = width / height
  let sourceX = 0
  let sourceY = 0
  let sourceWidth = image.naturalWidth
  let sourceHeight = image.naturalHeight

  if (sourceRatio > targetRatio) {
    sourceWidth = image.naturalHeight * targetRatio
    sourceX = (image.naturalWidth - sourceWidth) / 2
  } else {
    sourceHeight = image.naturalWidth / targetRatio
    sourceY = (image.naturalHeight - sourceHeight) / 2
  }

  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height)
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'))
}

export async function buildSplitScreenThumbnail(
  frame: Pick<FrameType, 'id' | 'width' | 'height' | 'rotate'>,
  layout: SplitScreenSceneLayout
): Promise<Blob | null> {
  if (typeof document === 'undefined') {
    return null
  }

  const dimensions = frameDisplayDimensions(frame)
  const canvasDimensions = fitCanvasDimensions(dimensions.width, dimensions.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvasDimensions.width
  canvas.height = canvasDimensions.height

  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }

  context.fillStyle = '#f8fafc'
  context.fillRect(0, 0, canvas.width, canvas.height)

  const rects = splitLayoutLeafRects(layout.root)
  const sceneIds = Array.from(new Set(rects.map((rect) => rect.sceneId).filter(Boolean))) as string[]
  const images = new Map<string, HTMLImageElement | null>()
  await Promise.all(sceneIds.map(async (sceneId) => images.set(sceneId, await fetchSceneImage(frame.id, sceneId))))

  for (const rect of rects) {
    const x = Math.round((rect.x / 100) * canvas.width)
    const y = Math.round((rect.y / 100) * canvas.height)
    const width = Math.max(1, Math.round((rect.width / 100) * canvas.width))
    const height = Math.max(1, Math.round((rect.height / 100) * canvas.height))
    const image = rect.sceneId ? images.get(rect.sceneId) : null

    context.save()
    context.beginPath()
    context.rect(x, y, width, height)
    context.clip()
    if (image) {
      drawCover(context, image, x, y, width, height)
    } else {
      context.fillStyle = '#e2e8f0'
      context.fillRect(x, y, width, height)
    }
    context.restore()

    context.strokeStyle = '#ffffff'
    context.lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * 0.008))
    context.strokeRect(x, y, width, height)
  }

  return await canvasToBlob(canvas)
}
