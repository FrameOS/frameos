import type { FrameType } from '../types'
import { getBasePath } from './getBasePath'
import { projectApiPath } from './projectApi'
import {
  defaultSplitScreenBackground,
  splitLayoutLeafBorderEdges,
  splitLayoutLeafRects,
  splitLayoutOuterBorderEdges,
  type SplitScreenBackground,
  type SplitScreenSceneLayout,
} from './splitScreenLayouts'

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

function splitBackground(layout: SplitScreenSceneLayout): SplitScreenBackground {
  return {
    ...defaultSplitScreenBackground,
    ...(layout.background ?? {}),
    opacity: Math.max(0, Math.min(1, Number(layout.background?.opacity ?? defaultSplitScreenBackground.opacity) || 0)),
  }
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

  const background = splitBackground(layout)
  context.fillStyle = background.color
  context.fillRect(0, 0, canvas.width, canvas.height)

  let backgroundImage: HTMLImageElement | null = null
  if (background.sceneId) {
    backgroundImage = await fetchSceneImage(frame.id, background.sceneId)
    if (backgroundImage) {
      context.save()
      context.globalAlpha = background.opacity
      drawCover(context, backgroundImage, 0, 0, canvas.width, canvas.height)
      context.restore()
    }
  }

  const rects = splitLayoutLeafRects(layout.root)
  const borderEdges = splitLayoutLeafBorderEdges(rects)
  const sceneIds = Array.from(new Set(rects.map((rect) => rect.sceneId).filter(Boolean))) as string[]
  const images = new Map<string, HTMLImageElement | null>()
  if (background.sceneId && backgroundImage) {
    images.set(background.sceneId, backgroundImage)
  }
  await Promise.all(
    sceneIds
      .filter((sceneId) => !images.has(sceneId))
      .map(async (sceneId) => images.set(sceneId, await fetchSceneImage(frame.id, sceneId)))
  )

  const scale = canvas.width / dimensions.width
  const borderWidth = Math.max(0, Math.round((Number(layout.borderWidth) || 0) * scale))
  const halfBorderWidth = borderWidth / 2
  const rawOuterBorderWidth = layout.outerBorderWidth ?? ((layout as any).outerBorder ? layout.borderWidth : 0)
  const outerBorderWidth = Math.max(0, Math.round((Number(rawOuterBorderWidth) || 0) * scale))

  for (const rect of rects) {
    const x = Math.round((rect.x / 100) * canvas.width)
    const y = Math.round((rect.y / 100) * canvas.height)
    const width = Math.max(1, Math.round((rect.width / 100) * canvas.width))
    const height = Math.max(1, Math.round((rect.height / 100) * canvas.height))
    const edges = borderEdges.get(rect.leafId) ?? { top: false, right: false, bottom: false, left: false }
    const outerEdges = outerBorderWidth > 0 ? splitLayoutOuterBorderEdges(rect) : null
    const insetTop = edges.top ? halfBorderWidth : outerEdges?.top ? outerBorderWidth : 0
    const insetRight = edges.right ? halfBorderWidth : outerEdges?.right ? outerBorderWidth : 0
    const insetBottom = edges.bottom ? halfBorderWidth : outerEdges?.bottom ? outerBorderWidth : 0
    const insetLeft = edges.left ? halfBorderWidth : outerEdges?.left ? outerBorderWidth : 0
    const cellX = Math.round(x + insetLeft)
    const cellY = Math.round(y + insetTop)
    const cellWidth = Math.max(1, Math.round(width - insetLeft - insetRight))
    const cellHeight = Math.max(1, Math.round(height - insetTop - insetBottom))
    const image = rect.sceneId ? images.get(rect.sceneId) : null

    context.save()
    context.beginPath()
    context.rect(cellX, cellY, cellWidth, cellHeight)
    context.clip()
    if (image) {
      drawCover(context, image, cellX, cellY, cellWidth, cellHeight)
    } else {
      context.fillStyle = '#e2e8f0'
      context.fillRect(cellX, cellY, cellWidth, cellHeight)
    }
    context.restore()
  }

  return await canvasToBlob(canvas)
}
