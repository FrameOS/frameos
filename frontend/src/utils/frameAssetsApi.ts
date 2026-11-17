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

/**
 * The places a frame keeps assets in, as its listing names them
 * (`storages: [{id, name}]`): the assets folder (`assets`: the TF card when
 * one is mounted, else the flash) and, on an ESP32 with a card, its internal
 * flash storage (`internal`). Every asset call takes the id as its `storage`
 * query parameter; absent means `assets`.
 */
export type AssetStorageId = 'assets' | 'internal'
export const DEFAULT_ASSET_STORAGE: AssetStorageId = 'assets'
export const ASSET_STORAGE_IDS: readonly AssetStorageId[] = ['assets', 'internal']

export interface AssetStorage {
  id: AssetStorageId
  /** The frame's own name for it ("TF card", "Internal storage"). */
  name: string
}

export function isAssetStorageId(value: unknown): value is AssetStorageId {
  return typeof value === 'string' && (ASSET_STORAGE_IDS as readonly string[]).includes(value)
}

/** The listing's `storages`, or null when it says nothing (an older plane or
 * frame: one storage, the assets folder). Unknown ids are dropped. */
export function assetStoragesFromListing(storages: unknown): AssetStorage[] | null {
  if (!Array.isArray(storages)) {
    return null
  }
  const result: AssetStorage[] = []
  for (const entry of storages) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const { id, name } = entry as { id?: unknown; name?: unknown }
    if (!isAssetStorageId(id) || result.some((storage) => storage.id === id)) {
      continue
    }
    result.push({ id, name: typeof name === 'string' && name.trim() ? name : id })
  }
  return result
}

/**
 * Which storage to show after a listing reported `storages`: the one shown
 * while the frame still has it, else the first it lists. A listing without
 * the key (or an empty one) knows only the assets folder.
 */
export function assetStorageAfterListing(current: AssetStorageId, storages: AssetStorage[] | null): AssetStorageId {
  const first = storages?.[0]
  if (!first) {
    return DEFAULT_ASSET_STORAGE
  }
  return storages.some((storage) => storage.id === current) ? current : first.id
}

/** `url` with the `storage` query parameter, left off for the default storage
 * so the URLs a one-storage frame sees are what they always were. */
export function withAssetStorage(url: string, storage?: AssetStorageId | null): string {
  if (!storage || storage === DEFAULT_ASSET_STORAGE) {
    return url
  }
  return `${url}${url.includes('?') ? '&' : '?'}storage=${encodeURIComponent(storage)}`
}

interface FrameAssetUrlOptions {
  thumb?: boolean
  mode?: 'download' | 'image'
  filename?: string
  storage?: AssetStorageId | null
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
  if (options.storage && options.storage !== DEFAULT_ASSET_STORAGE) {
    params.set('storage', options.storage)
  }
  // Browser-facing (an <img src>, an <a href>), so it cannot lean on apiFetch
  // to prepend the base path: under Home Assistant ingress a bare
  // /api/projects/… URL is Home Assistant's own /api/, which answers 404 for
  // every thumbnail on the page.
  return `${getBasePath()}${frameAssetApiPrefix(frameId)}/asset?${params.toString()}`
}
