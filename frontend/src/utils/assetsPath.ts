// Where a Linux frame's NEW assets folder may be (frameos/src/frameos/config.nim,
// assetsPathAllowed; backend/app/utils/assets_path.py). Scenes and the
// frame's asset routes write there, so it must never be, or contain, the
// runtime's own files. A folder stored before the rule keeps working, and an
// ESP32 mounts its SD card at its assets path and is not held to this.

export const ASSETS_PATH_ROOTS = ['/srv/assets', '/mnt', '/media'] as const
export const ASSETS_PATH_RULE = 'The assets path must be /srv/assets, /mnt or /media, or a folder inside one of them.'

export function assetsPathAllowed(path: string): boolean {
  const trimmed = path.replace(/\/+$/, '')
  if (!trimmed.startsWith('/')) {
    return false
  }
  if (
    trimmed
      .slice(1)
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return false
  }
  return ASSETS_PATH_ROOTS.some((root) => trimmed === root || trimmed.startsWith(`${root}/`))
}

/** The form's error for an assets path, or undefined when there is nothing to
 * say: empty, inside the roots, or the folder the frame already has. */
export function assetsPathError(path: string | null | undefined, stored?: string | null): string | undefined {
  const value = path?.trim()
  if (!value || assetsPathAllowed(value)) {
    return undefined
  }
  const unchanged = value.replace(/\/+$/, '') === (stored ?? '').trim().replace(/\/+$/, '')
  return unchanged ? undefined : ASSETS_PATH_RULE
}
