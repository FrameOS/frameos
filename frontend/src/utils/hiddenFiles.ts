/**
 * Hidden / OS-junk file rules for the assets browser.
 *
 * This is the TypeScript mirror of the device-side Nim implementation in
 * `frameos/src/frameos/utils/paths.nim` — keep the two rule lists in sync.
 * The device uses them to keep junk out of image rotations; the UI uses them
 * to keep the assets list clean unless "Show hidden files" is toggled on.
 */

/** Junk file basenames (compared lowercased). */
const junkFileNames = new Set(['thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', 'desktop.ini'])

/**
 * Junk directory basenames (compared lowercased). The dot-prefixed ones are
 * already covered by the "hidden" rule; they are listed for clarity.
 */
const junkDirNames = new Set([
  '$recycle.bin',
  'recycler',
  'system volume information',
  '@eadir',
  '__macosx',
  '.appledouble',
  '.spotlight-v100',
  '.trashes',
  '.fseventsd',
  '.temporaryitems',
  '.documentrevisions-v100',
])

/**
 * Temporary / partial download extensions, plus Windows shortcuts. Only the
 * trailing extension counts, so `photo.tmp.jpg` is a normal image.
 */
const junkFileExtensions = ['.tmp', '.temp', '.part', '.crdownload', '.download', '.lnk']

/** Any basename starting with a dot — `.DS_Store`, `._IMG_1234.jpg`, dotfiles. */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}

/** True for directories that should never be shown or descended into. */
export function isJunkDirName(name: string): boolean {
  if (!name || name === '.' || name === '..') {
    return true
  }
  return isHiddenName(name) || junkDirNames.has(name.toLowerCase())
}

/** True for OS/temp droppings that should never appear in the assets list. */
export function isHiddenOrJunkFileName(name: string): boolean {
  if (!name) {
    return true
  }
  if (isHiddenName(name) || name.endsWith('~')) {
    return true
  }
  const lower = name.toLowerCase()
  if (junkFileNames.has(lower) || junkDirNames.has(lower)) {
    return true
  }
  return junkFileExtensions.some((extension) => lower.endsWith(extension))
}

/**
 * True when any component of an asset path is hidden/junk — the leading
 * components judged as directories, the last one as a file.
 */
export function isHiddenOrJunkAssetPath(path: string): boolean {
  const parts = path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')
  if (parts.length === 0) {
    return false
  }
  for (let index = 0; index < parts.length - 1; index++) {
    if (isJunkDirName(parts[index])) {
      return true
    }
  }
  return isHiddenOrJunkFileName(parts[parts.length - 1])
}
