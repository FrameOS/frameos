import { isInFrameAdminMode } from './frameAdmin'

function frameAssetApiPrefix(frameId: number): string {
  const prefix = isInFrameAdminMode() ? '/api/admin/frames' : '/api/frames'
  return `${prefix}/${frameId}`
}

export function frameAssetsApiPath(frameId: number, suffix = 'assets'): string {
  return `${frameAssetApiPrefix(frameId)}/${suffix}`
}

interface FrameAssetUrlOptions {
  thumb?: boolean
  mode?: 'download' | 'image'
  filename?: string
}

export function frameAssetUrl(
  frameId: number,
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
  return `${frameAssetApiPrefix(frameId)}/asset?${params.toString()}`
}
