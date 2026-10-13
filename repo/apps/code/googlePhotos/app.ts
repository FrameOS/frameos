// Google Photos shared album app. Google offers no API for shared albums, so
// the public share page is fetched with frameos.httpRequest and scraped for
// photo URLs; the photo itself goes through frameos.fetchImage (native decode,
// straight into the canvas on an ESP32). Only the URL list outlives a fetch:
// the page itself is dropped as soon as it has been parsed.

export const PHOTO_URL_HOST = 'https://lh3.googleusercontent.com/'
const MIN_PHOTO_PATH_LENGTH = 60
const ALBUM_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const ALBUM_TIMEOUT = 60000
const DEFAULT_CACHE_SECONDS = 3600
// The characters a photo path may hold, raw or JSON-escaped (\u003d, \/).
const PHOTO_PATH = /[A-Za-z0-9_\-\/=.\\]*/y

// What must outlive a render is kept with frameos.remember, never in module
// variables: an ESP32 tears this interpreter down after every render. The
// node keeps it until its scene is unloaded, as the Nim app object did.
const ALBUM_KEY = 'album'
const ALBUM_NOT_KEPT_KEY = 'albumNotKept'
const COUNTER_KEY = 'counter'

type Album = { shareUrl: string; urls: string[]; fetchedAt: number }

// Pull googleusercontent photo base URLs out of a shared album page. URLs
// appear both raw and JSON-escaped (\u003d for '='); size suffixes after '='
// are stripped so callers can append their own.
export function extractPhotoUrls(html: string): string[] {
  const seen = new Set<string>()
  const urls: string[] = []
  let searchFrom = 0
  while (true) {
    const start = html.indexOf(PHOTO_URL_HOST, searchFrom)
    if (start < 0) break
    PHOTO_PATH.lastIndex = start + PHOTO_URL_HOST.length
    let path = PHOTO_PATH.exec(html)?.[0] ?? ''
    searchFrom = start + PHOTO_URL_HOST.length + path.length
    path = path
      .replace(/\\+$/, '')
      .replace(/\\u003d/g, '=')
      .replace(/\\u0026/g, '&')
      .replace(/\\\//g, '/')
    const suffixStart = path.indexOf('=')
    if (suffixStart >= 0) path = path.slice(0, suffixStart)
    if (path.length <= MIN_PHOTO_PATH_LENGTH) continue
    if (!(path.startsWith('pw/') || path.includes('AF1Qip'))) continue
    const url = PHOTO_URL_HOST + path
    if (!seen.has(url)) {
      seen.add(url)
      urls.push(url)
    }
  }
  return urls
}

export function sizedPhotoUrl(baseUrl: string, width: number, height: number, fitMode: string): string {
  const suffix = fitMode === 'contain' ? '-no' : '-c'
  return `${baseUrl}=w${width}-h${height}${suffix}`
}

export function wrapIndex(counter: number, count: number): number {
  if (count <= 0) return 0
  return ((counter % count) + count) % count
}

export function cacheSeconds(value: unknown): number {
  const seconds = Math.trunc(Number(value))
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_CACHE_SECONDS
}

// A saved counter that is not an integer counts as 0.
export function stateCounter(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : 0
}

// The context image when there is one, else the frame's size after rotation.
export function renderSize(app: FrameOSApp, context: FrameOSContext): { width: number; height: number } {
  if (context.imageWidth && context.imageHeight) return { width: context.imageWidth, height: context.imageHeight }
  const { width, height, rotate } = app.frame
  return rotate === 90 || rotate === 270 ? { width: height, height: width } : { width, height }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fetchAlbum(shareUrl: string, debug: boolean): string[] {
  if (debug) frameos.log(`Fetching shared album: ${shareUrl}`)
  const response = frameos.httpRequest(shareUrl, {
    headers: { 'User-Agent': ALBUM_USER_AGENT, Accept: 'text/html' },
    timeoutMs: ALBUM_TIMEOUT,
  })
  if (response.status === 0) throw new Error(response.error || 'request failed')
  if (response.status !== 200) throw new Error(`Error ${response.status} while fetching the shared album page.`)
  const urls = extractPhotoUrls(response.body ?? '')
  if (!urls.length) {
    throw new Error(
      'No photos found on the shared album page. Make sure the link is a public share link and the album is not empty.'
    )
  }
  if (debug) frameos.log(`Found ${urls.length} photos in the shared album`)
  return urls
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function errorPanel(width: number, height: number, message: string): string {
  const size = Math.max(14, Math.round(Math.min(width, height) / 24))
  const max = Math.max(10, Math.floor((width - 2 * size) / (size * 0.55)))
  const lines: string[] = []
  let line = ''
  for (const word of message.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  const text = lines
    .map(
      (l, i) =>
        `<text x="${size}" y="${
          size * 2 + i * Math.round(size * 1.35)
        }" font-family="Ubuntu" font-size="${size}" fill="#111111">${esc(l)}</text>`
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>${text}</svg>`
}

// The album this node kept on an earlier render, if any.
export function keptAlbum(value: unknown): Album | null {
  if (!value || typeof value !== 'object') return null
  const kept = value as Record<string, unknown>
  if (typeof kept.shareUrl !== 'string' || !Array.isArray(kept.urls) || typeof kept.fetchedAt !== 'number') return null
  return { shareUrl: kept.shareUrl, urls: kept.urls as string[], fetchedAt: kept.fetchedAt }
}

// Keep a fetched album for the next renders. One too big for the node's
// memory serves this render only, and is said once per link and size: the
// next fetch of the same album does not ask (and get refused) again.
function keepAlbum(album: Album): void {
  const notKept = frameos.recall(ALBUM_NOT_KEPT_KEY) as { shareUrl?: string; count?: number } | undefined
  const count = album.urls.length
  if (notKept && notKept.shareUrl === album.shareUrl && notKept.count === count) return
  if (frameos.remember(ALBUM_KEY, album)) {
    if (notKept) frameos.remember(ALBUM_NOT_KEPT_KEY, null)
    return
  }
  frameos.remember(ALBUM_KEY, null)
  frameos.remember(ALBUM_NOT_KEPT_KEY, { shareUrl: album.shareUrl, count })
  frameos.log(
    `The shared album's ${count} photos are too many to keep between renders: the album page is fetched again on every render.`
  )
}

// The album to show from: the kept one while it is fresh, else a new fetch;
// a failed refresh falls back to the kept list of the same link.
function loadAlbum(shareUrl: string, maxAgeSeconds: number, debug: boolean): Album | string {
  const kept = keptAlbum(frameos.recall(ALBUM_KEY))
  const fresh =
    kept && kept.urls.length > 0 && kept.shareUrl === shareUrl && Date.now() / 1000 - kept.fetchedAt < maxAgeSeconds
  if (kept && fresh) return kept
  try {
    const album = { shareUrl, urls: fetchAlbum(shareUrl, debug), fetchedAt: Date.now() / 1000 }
    keepAlbum(album)
    return album
  } catch (error) {
    if (kept && kept.urls.length > 0 && kept.shareUrl === shareUrl) {
      frameos.error(`Error refreshing the shared album, reusing the cached photo list: ${errorMessage(error)}`)
      return kept
    }
    return `Error loading the shared album: ${errorMessage(error)}`
  }
}

// The sequential position: the node's own, or on its first render since the
// scene loaded, the counter state key's (the Nim app restored it in init).
function sequentialCounter(app: FrameOSApp, counterStateKey: string): number {
  const kept = frameos.recall(COUNTER_KEY)
  if (typeof kept === 'number' && Number.isInteger(kept)) return kept
  return counterStateKey ? stateCounter(app.state[counterStateKey]) : 0
}

export function get(app: FrameOSApp, context: FrameOSContext): unknown {
  const { width, height } = renderSize(app, context)
  const fail = (message: string): unknown => {
    frameos.error(message)
    return frameos.svg(errorPanel(width, height, message), { width, height })
  }
  const c = app.config
  const shareUrl = String(c.shareUrl ?? '').trim()
  const mode = String(c.mode ?? 'random')
  const counterStateKey = String(c.counterStateKey ?? '').trim()
  const metadataStateKey = String(c.metadataStateKey ?? '').trim()
  const fitMode = String(c.fitMode ?? 'cover')
  const saveAssets = String(c.saveAssets ?? 'auto')
  const debug = app.frame.debug === true

  if (!shareUrl) return fail('Please provide a Google Photos shared album link.')
  if (!shareUrl.startsWith('http://') && !shareUrl.startsWith('https://')) {
    return fail(`Invalid shared album link: ${shareUrl}`)
  }

  try {
    const album = loadAlbum(shareUrl, cacheSeconds(c.cacheAlbumSeconds), debug)
    if (typeof album === 'string') return fail(album)

    const count = album.urls.length
    let index = 0
    if (mode === 'sequential') {
      index = wrapIndex(sequentialCounter(app, counterStateKey), count)
      const next = wrapIndex(index + 1, count)
      frameos.remember(COUNTER_KEY, next)
      if (counterStateKey) frameos.setState(counterStateKey, next)
    } else {
      index = Math.floor(Math.random() * count)
    }

    const imageUrl = sizedPhotoUrl(album.urls[index], width, height, fitMode)
    if (debug) frameos.log(`Downloading image: ${imageUrl}`)
    const saveAsset =
      saveAssets === 'auto' || saveAssets === 'always'
        ? { name: `google-photos ${index} ${width}x${height}`, extension: 'jpg', mode: saveAssets }
        : undefined
    const photo = frameos.fetchImage(imageUrl, { saveAsset })
    if (!photo.image) return fail(`Error fetching image from Google Photos: ${photo.error ?? 'no image'}`)

    if (metadataStateKey) {
      frameos.setState(metadataStateKey, { source: 'googlePhotos', index, count, imageUrl })
    }
    return photo.image
  } catch (error) {
    return fail(`Error fetching image from Google Photos: ${errorMessage(error)}`)
  }
}
