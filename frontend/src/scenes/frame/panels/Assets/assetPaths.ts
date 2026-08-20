export interface AssetPathEntry {
  path: string
}

export function normalizeAssetsPath(assetsPath?: string): string {
  let normalizedPath = (assetsPath || '/srv/assets').replace(/\/+$/, '') || '/srv/assets'
  while (normalizedPath.startsWith('./')) {
    normalizedPath = normalizedPath.slice(2)
  }
  return normalizedPath || '.'
}

/**
 * Paths the backend speaks: absolute under the frame's assets directory
 * ("/srv/assets/photos/a.jpg"). Anything relative is anchored there.
 */
export function normalizeAssetPath(path: string, assetsPath?: string): string {
  const rawAssetsPath = (assetsPath || '/srv/assets').replace(/\/+$/, '') || '/srv/assets'
  const normalizedAssetsPath = normalizeAssetsPath(assetsPath)
  if (!path) {
    return normalizedAssetsPath
  }
  if (
    path === rawAssetsPath ||
    path.startsWith(`${rawAssetsPath}/`) ||
    path === normalizedAssetsPath ||
    path.startsWith(`${normalizedAssetsPath}/`)
  ) {
    return path
  }
  if (path.startsWith('/')) {
    return path
  }
  const normalizedPath = path.replace(/^\.\/+/, '').replace(/^\/+/, '')
  return normalizedPath ? `${normalizedAssetsPath}/${normalizedPath}` : normalizedAssetsPath
}

/**
 * One key for every spelling of the same asset. The listing can hold either
 * absolute backend paths ("/srv/assets/photos/a.jpg") or the relative paths
 * the cloud hub caches from the device ("photos/a.jpg", "./photos/a.jpg");
 * both collapse to "photos/a.jpg". The root itself is "".
 */
export function assetPathKey(path: string, assetsPath?: string): string {
  const rawAssetsPath = (assetsPath || '/srv/assets').replace(/\/+$/, '') || '/srv/assets'
  const normalizedAssetsPath = normalizeAssetsPath(assetsPath)
  let key = path
  for (const prefix of [rawAssetsPath, normalizedAssetsPath]) {
    if (key === prefix) {
      return ''
    }
    if (key.startsWith(`${prefix}/`)) {
      key = key.slice(prefix.length + 1)
      break
    }
  }
  key = key
    .replace(/^(\.\/+)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  return key === '.' ? '' : key
}

function isUnderKey(key: string, parentKey: string): boolean {
  return key === parentKey || key.startsWith(`${parentKey}/`)
}

/** Drop the deleted entry and everything below it, whatever spelling the listing uses. */
export function withoutDeletedAsset<T extends AssetPathEntry>(assets: T[], path: string, assetsPath?: string): T[] {
  const deletedKey = assetPathKey(path, assetsPath)
  if (!deletedKey) {
    return assets
  }
  return assets.filter((asset) => !isUnderKey(assetPathKey(asset.path, assetsPath), deletedKey))
}

/**
 * Move the renamed entry (and its subtree) to the new path, keeping each
 * row's own spelling: absolute rows stay absolute, relative rows stay relative.
 */
export function withRenamedAsset<T extends AssetPathEntry>(
  assets: T[],
  oldPath: string,
  newPath: string,
  assetsPath?: string
): T[] {
  const oldKey = assetPathKey(oldPath, assetsPath)
  const newKey = assetPathKey(newPath, assetsPath)
  if (!oldKey || !newKey) {
    return assets
  }
  return assets.map((asset) => {
    const key = assetPathKey(asset.path, assetsPath)
    if (!isUnderKey(key, oldKey)) {
      return asset
    }
    const movedKey = `${newKey}${key.slice(oldKey.length)}`
    const movedPath = asset.path.startsWith('/')
      ? normalizeAssetPath(movedKey, assetsPath)
      : asset.path.startsWith('./')
      ? `./${movedKey}`
      : movedKey
    return { ...asset, path: movedPath }
  })
}
