import { isInFrameAdminMode } from './frameAdmin'

function frameAssetApiPrefix(frameId: number): string {
  const prefix = isInFrameAdminMode() ? '/api/admin/frames' : '/api/frames'
  return `${prefix}/${frameId}`
}

export function frameAssetsApiPath(frameId: number, suffix = 'assets'): string {
  return `${frameAssetApiPrefix(frameId)}/${suffix}`
}

export function frameAssetUrl(frameId: number, path: string, thumb = false): string {
  const params = new URLSearchParams({ path })
  if (thumb) {
    params.set('thumb', '1')
  }
  return `${frameAssetApiPrefix(frameId)}/asset?${params.toString()}`
}
