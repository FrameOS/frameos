import { isInFrameAdminMode } from './frameAdmin'
import { getBasePath } from './getBasePath'
import { projectApiPathFromCache } from './projectApi'
import type { FrameId } from '../types'

function frameAssetApiPrefix(frameId: FrameId): string {
  const prefix = isInFrameAdminMode() ? '/api/admin/frames' : projectApiPathFromCache('/api/frames')
  return `${prefix}/${frameId}`
}

export function frameAssetsApiPath(frameId: FrameId, suffix = 'assets'): string {
  return `${frameAssetApiPrefix(frameId)}/${suffix}`
}

interface FrameAssetUrlOptions {
  thumb?: boolean
  mode?: 'download' | 'image'
  filename?: string
}

export function frameAssetUrl(
  frameId: FrameId,
  path: string,
  thumbOrOptions: boolean | FrameAssetUrlOptions = false
): string {
  const options = typeof thumbOrOptions === 'boolean' ? { thumb: thumbOrOptions } : thumbOrOptions
  const params = new URLSearchParams({ path })
  if (options.thumb) {
    params.set('thumb', '1')
  }
  if (options.mode) {
    params.set('mode', options.mode)
  }
  if (options.filename) {
    params.set('filename', options.filename)
  }
  // Browser-facing (an <img src>, an <a href>), so it cannot lean on apiFetch
  // to prepend the base path: under Home Assistant ingress a bare
  // /api/projects/… URL is Home Assistant's own /api/, which answers 404 for
  // every thumbnail on the page.
  return `${getBasePath()}${frameAssetApiPrefix(frameId)}/asset?${params.toString()}`
}
