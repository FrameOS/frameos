// Local Image: one picture of the frame's files, or a folder of them one per
// render (the port of the built-in data/localImage, docs/retired-apps.md).
// The folder is the frame's assets folder (an ESP32's SD card) or
// /srv/internal; anything else is outside what a JS app may read. Where it is
// in the folder is remembered (frameos.remember): on an ESP32 the interpreter
// does not outlive a render.

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg']
// The ESP32 firmware is built without pixie's QOI and PPM codecs.
const HOST_ONLY_EXTENSIONS = ['.qoi', '.ppm']
const INTERNAL_ROOT = '/srv/internal'
const MEMORY_KEY = 'slideshow'

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
}

export function isImage(file: string, embedded: boolean): boolean {
  const lower = asciiLower(file)
  const extensions = embedded ? IMAGE_EXTENSIONS : IMAGE_EXTENSIONS.concat(HOST_ONLY_EXTENSIONS)
  return extensions.some((extension) => lower.endsWith(extension))
}

// By name ignoring ASCII case, then exactly: the built-in app's order.
export function compareImagePaths(a: string, b: string): number {
  const la = asciiLower(a)
  const lb = asciiLower(b)
  if (la !== lb) return la < lb ? -1 : 1
  return a === b ? 0 : a < b ? -1 : 1
}

function trimSlashes(text: string): string {
  return text.length > 1 ? text.replace(/\/+$/, '') : text
}

// Where `path` is among the frame's storages: the storage and the path in it
// ('' for its root), or null when it is outside them.
export function resolveFolder(path: unknown, assetsPath: string): { storage: string; dir: string } | null {
  const wanted = trimSlashes(String(path ?? '').trim())
  if (!wanted) return { storage: 'assets', dir: '' }
  for (const [storage, root] of [
    ['assets', trimSlashes(assetsPath || '/srv/assets')],
    ['internal', INTERNAL_ROOT],
  ]) {
    if (wanted === root) return { storage, dir: '' }
    if (wanted.startsWith(root + '/')) {
      const dir = wanted.slice(root.length + 1)
      if (dir.split('/').includes('..')) return null
      return { storage, dir }
    }
  }
  return null
}

// FNV-1a over the names: the folder's contents, small enough to remember.
export function listHash(files: string[]): string {
  let hash = 0x811c9dc5
  for (const file of files) {
    for (let i = 0; i < file.length; i++) {
      hash ^= file.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash = Math.imul(hash ^ 10, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

// A shuffle of the sorted names that one seed always repeats (mulberry32), so
// a random order outlives the interpreter as two numbers, not the whole list.
export function shuffled(files: string[], seed: number): string[] {
  const list = files.slice()
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const swap = list[i]
    list[i] = list[j]
    list[j] = swap
  }
  return list
}

function newSeed(): number {
  return Math.floor(Math.random() * 4294967296) >>> 0
}

interface Memory {
  path: string
  search: string
  order: string
  seed: number
  hash: string
  counter: number
  last: string | null
}

function within(storage: string): { storage?: 'internal' } {
  return storage === 'internal' ? { storage: 'internal' } : {}
}

// The images of the folder, by their path in it, sorted. A path to one image
// is that image alone (filename ''), whatever its name looks like.
function folderImages(storage: string, dir: string, search: string, embedded: boolean): string[] {
  if (dir && frameos.assetExists(dir, within(storage))) {
    return isImage(dir, embedded) ? [''] : []
  }
  const query = search.toLowerCase()
  const prefix = dir ? dir + '/' : ''
  const images: string[] = []
  for (const file of frameos.listAssets(dir, within(storage))) {
    if (!file.startsWith(prefix)) continue
    const name = file.slice(prefix.length)
    if (!isImage(name, embedded)) continue
    if (query && !name.toLowerCase().includes(query)) continue
    // An empty file is not an image, whatever it is called (the Waveshare
    // demo card's zero-byte sys_decode.bmp).
    if (!(frameos.assetSize(file, within(storage)) > 0)) continue
    images.push(name)
  }
  return images.sort(compareImagePaths)
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// The error as a picture: white, the message wrapped in it.
export function errorPanel(width: number, height: number, message: string): string {
  const size = Math.max(10, Math.round(Math.min(width, height) / 24))
  const max = Math.max(10, Math.floor((width - 2 * size) / (size * 0.55)))
  const lines: string[] = []
  for (const paragraph of message.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > max) {
        lines.push(line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    if (line) lines.push(line)
  }
  const text = lines
    .map(
      (l, i) =>
        `<text x="${size}" y="${size * 2 + i * Math.round(size * 1.35)}" font-family="Ubuntu" font-size="${size}" fill="#111111">${esc(l)}</text>`
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>${text}</svg>`
}

// The error frame's size: the target's, or the canvas's. On a device a whole
// fraction of the canvas under 512 KB, as the built-in app's was: a frame-sized
// picture beside the canvas is what an 8 MB board does not have, and the node
// cache keeps this one (a consumer's bounds are no reason to make it bigger).
export function errorFrameSize(context: FrameOSContext | undefined, frame: FrameOSApp['frame']): [number, number] {
  const targeted = !frame.embedded && !!(context?.targetWidth && context?.targetHeight)
  const width = (targeted ? context?.targetWidth : context?.imageWidth) || frame.width || 800
  const height = (targeted ? context?.targetHeight : context?.imageHeight) || frame.height || 480
  if (!frame.embedded) return [width, height]
  let k = 1
  while (Math.floor(width / k) * Math.floor(height / k) * 4 > 512 * 1024) k++
  return [Math.max(1, Math.floor(width / k)), Math.max(1, Math.floor(height / k))]
}

function stateCounter(value: unknown): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function get(app: FrameOSApp, context: FrameOSContext): unknown {
  const path = String(app.config.path ?? '').trim()
  const search = String(app.config.search ?? '')
  // Anything but random is by name, as the built-in app read it.
  const order = app.config.order === 'random' ? 'random' : 'alphabetical'
  const counterKey = String(app.config.counterStateKey ?? '').trim()
  const metadataKey = String(app.config.metadataStateKey ?? '').trim()
  const assetsPath = app.frame.assetsPath || '/srv/assets'
  const folder = path ? trimSlashes(path) : trimSlashes(assetsPath)
  // An error is logged and shown, not thrown: the picture is the node's value,
  // which its cache keeps for its period, so under an animation an empty
  // folder is looked at, and logged, once a period and not every frame.
  const fail = (message: string): unknown => {
    frameos.error(message)
    const [width, height] = errorFrameSize(context, app.frame)
    return frameos.svg(errorPanel(width, height, message), { width, height })
  }
  const where = resolveFolder(path, assetsPath)
  if (!where) return fail(`${path} is outside the frame's files: put the photos in ${assetsPath}`)

  const sorted = folderImages(where.storage, where.dir, search, !!app.frame.embedded)
  const recalled = frameos.recall(MEMORY_KEY) as Memory | undefined | null
  const fresh = !recalled || recalled.path !== path || recalled.search !== search || recalled.order !== order
  const memory: Memory = fresh
    ? { path, search, order, seed: newSeed(), hash: listHash(sorted), counter: 0, last: null }
    : { ...recalled }
  if (fresh) {
    if (search) frameos.log('Search query: ' + search)
    frameos.log(`Found ${sorted.length} images in the folder: ${folder}`)
  }
  // A random order is shuffled again only when the folder's contents change.
  const hash = listHash(sorted)
  if (order === 'random' && hash !== memory.hash) memory.seed = newSeed()
  memory.hash = hash
  const images = order === 'random' ? shuffled(sorted, memory.seed) : sorted

  if (images.length === 0) {
    frameos.remember(MEMORY_KEY, memory as unknown as FrameOSJson)
    if (search) return fail(`No images matching the search query "${search}" found in the folder: ${path}`)
    return fail(`No images found in the folder: ${path}`)
  }

  if (fresh && order !== 'random' && counterKey) {
    memory.counter = stateCounter(app.state[counterKey]) % images.length
  }
  // After the photo shown last, wherever the folder's changes put it.
  if (memory.last !== null) {
    const lastIndex = images.indexOf(memory.last)
    if (lastIndex >= 0) memory.counter = (lastIndex + 1) % images.length
  }
  memory.counter %= images.length

  // The node cache could not keep the photo it asked for and wants it again
  // (an animation over it on a board short of memory), or its scene is drawn
  // again before it is due: the same photo, the counter untouched. A
  // slideshow steps on its schedule, never the frame rate.
  const lastIndex =
    (context?.remakingCachedValue || context?.repainting) && memory.last !== null ? images.indexOf(memory.last) : -1
  const remaking = lastIndex >= 0
  const index = remaking ? lastIndex : memory.counter
  const filename = images[index]
  const shownPath = filename ? `${folder}/${filename}` : folder
  const inStorage = filename ? (where.dir ? `${where.dir}/${filename}` : filename) : where.dir
  if (!remaking) {
    frameos.log('Loading image: ' + shownPath)
    memory.counter = (memory.counter + 1) % images.length
    if (counterKey) frameos.setState(counterKey, memory.counter)
  }
  memory.last = filename
  frameos.remember(MEMORY_KEY, memory as unknown as FrameOSJson)

  // No size: decoded straight into the canvas it is drawn on where the
  // runtime offers one, else at the consumer's bounds.
  const wantMetadata = !!metadataKey && !remaking
  const image = frameos.loadAssetImage(inStorage, { ...within(where.storage), ...(wantMetadata ? { exif: true } : {}) })
  if (!image) return fail(`An error occurred while loading the image: ${shownPath}`)
  if (wantMetadata) {
    const metadata: Record<string, FrameOSJson> = {
      path: shownPath,
      filename,
      index,
      total: images.length,
      width: image.width,
      height: image.height,
    }
    if (image.exif) metadata.exif = image.exif as FrameOSJson
    if (image.exifSummary) metadata.exifSummary = image.exifSummary
    frameos.setState(metadataKey, metadata)
  }
  return image
}
