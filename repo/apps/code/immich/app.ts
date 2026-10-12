// Immich photo app. JSON over frameos.httpRequest; the photo itself goes
// through frameos.fetchImage (native decode, straight into the canvas on an
// ESP32). Older firmware without fetchImage gets the base64 fallback.

const TIMEOUT = 30000

type Asset = {
  id: string
  type?: string
  originalFileName?: string
  isFavorite?: boolean
  exifInfo?: Record<string, unknown> | null
  people?: { name?: string }[] | null
}
type Picked = { asset: Asset | null; message: string }
type Response = { status: number; body?: string; bodyBase64?: string; error?: string }

export function normalizeServerUrl(url: unknown): string {
  return String(url ?? '').trim().replace(/\/+$/, '')
}

export function assetDownloadUrl(serverUrl: string, assetId: string, previewSize: string): string {
  const id = encodeURIComponent(assetId)
  return previewSize === 'fullsize'
    ? `${serverUrl}/api/assets/${id}/original`
    : `${serverUrl}/api/assets/${id}/thumbnail?size=preview`
}

// Bare YYYY-MM-DD: Immich 3 rejects a time suffix. Local where the frame has
// a zone, UTC otherwise.
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function randomSearchBody(albumId = '', personId = '', isFavorite = false): Record<string, unknown> {
  const body: Record<string, unknown> = { size: 1, type: 'IMAGE', withExif: true, withPeople: true }
  if (albumId) body.albumIds = [albumId]
  if (personId) body.personIds = [personId]
  if (isFavorite) body.isFavorite = true
  return body
}

// Keep only what the render needs: a parsed response costs many times its
// JSON size on the heap.
function slim(asset: Record<string, any>): Asset {
  const out: Asset = { id: String(asset.id ?? ''), type: asset.type }
  if (asset.originalFileName) out.originalFileName = String(asset.originalFileName)
  if (asset.isFavorite) out.isFavorite = true
  if (asset.exifInfo && typeof asset.exifInfo === 'object') out.exifInfo = asset.exifInfo
  if (Array.isArray(asset.people)) out.people = asset.people.map((p: any) => ({ name: p?.name }))
  return out
}

export function imageAssets(assets: unknown): Asset[] {
  if (!Array.isArray(assets)) return []
  return assets.filter((a) => a && typeof a === 'object' && a.type === 'IMAGE').map(slim)
}

export function memoriesImageAssets(memories: unknown): Asset[] {
  if (!Array.isArray(memories)) return []
  return memories.flatMap((m) => (m && typeof m === 'object' ? imageAssets(m.assets) : []))
}

export function pickRandomAsset(assets: Asset[]): Asset | null {
  return assets.length ? assets[Math.floor(Math.random() * assets.length)] : null
}

export function assetMetadata(asset: Asset): Record<string, unknown> {
  const meta: Record<string, unknown> = { source: 'immich', id: asset.id ?? '', originalFileName: asset.originalFileName ?? '' }
  const exif = asset.exifInfo
  if (exif && typeof exif === 'object') {
    for (const key of ['make', 'model', 'fNumber', 'exposureTime', 'iso', 'focalLength', 'dateTimeOriginal']) {
      if (exif[key] !== undefined && exif[key] !== null) meta[key] = exif[key]
    }
  }
  const names = (asset.people ?? []).map((p) => p?.name ?? '').filter((n) => n !== '')
  if (names.length) meta.people = names
  return meta
}

// Only a short alphanumeric suffix may reach a path under the assets folder.
export function assetFileExtension(asset: Asset, previewSize: string): string {
  const match = previewSize === 'fullsize' ? /^.+\.([a-z0-9]{1,5})$/i.exec(asset.originalFileName ?? '') : null
  return match ? `.${match[1].toLowerCase()}` : '.jpg'
}

export function assetBaseName(asset: Asset): string {
  const name = (asset.originalFileName ?? '').replace(/\.[^.]*$/, '')
  return name || asset.id || 'immich'
}

export function httpErrorMessage(r: Response): string {
  if (r.status === 0) return r.error ? `request failed: ${r.error}` : 'request failed'
  let message = `HTTP ${r.status}`
  const body = r.body ?? ''
  try {
    const json = JSON.parse(body)
    const d = json?.message
    if (typeof d === 'string' && d) message += `: ${d}`
    else if (Array.isArray(d) && d.length) message += `: ${typeof d[0] === 'string' ? d[0] : JSON.stringify(d[0])}`
    else if (typeof json?.error === 'string' && json.error) message += `: ${json.error}`
  } catch {
    if (body.length > 0 && body.length < 300) message += `: ${body}`
  }
  return message
}

function request(apiKey: string, url: string, method = 'GET', body = ''): Response {
  return frameos.httpRequest(url, {
    method,
    headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
    body,
    timeoutMs: TIMEOUT,
  })
}

function parse(body: string | undefined): unknown {
  try {
    return JSON.parse(body ?? '')
  } catch {
    return null
  }
}

function fetchRandomAsset(
  serverUrl: string,
  apiKey: string,
  albumId = '',
  personId = '',
  isFavorite = false,
  emptyMessage = 'Immich returned no image assets.'
): Picked {
  let r = request(apiKey, `${serverUrl}/api/search/random`, 'POST', JSON.stringify(randomSearchBody(albumId, personId, isFavorite)))
  let legacy = false
  if (r.status === 404) {
    // Older servers: no server-side filters, ask for a batch and filter here.
    frameos.log('This Immich server lacks POST /api/search/random; falling back to /api/assets/random where album/person/favorite filters cannot be applied.')
    r = request(apiKey, `${serverUrl}/api/assets/random?count=20`)
    legacy = true
  }
  if (r.status !== 200) return { asset: null, message: `Error fetching a random image from Immich: ${httpErrorMessage(r)}` }
  let assets = imageAssets(parse(r.body))
  if (legacy && isFavorite) assets = assets.filter((a) => a.isFavorite)
  const scope = albumId ? `album ${albumId}` : personId ? `person ${personId}` : isFavorite ? 'favorites' : 'whole library'
  frameos.log(`Immich random search (${scope}): HTTP ${r.status}, ${assets.length} image candidate(s)`)
  if (!assets.length) {
    return { asset: null, message: legacy ? 'This Immich server returned no matching images from /api/assets/random.' : emptyMessage }
  }
  return { asset: pickRandomAsset(assets), message: '' }
}

function downloadPhoto(url: string, apiKey: string, saveAsset: { name: string; extension: string; mode: string } | null) {
  const headers = { 'x-api-key': apiKey }
  if (typeof frameos.fetchImage === 'function') return frameos.fetchImage(url, saveAsset ? { headers, saveAsset } : { headers })
  const r = frameos.httpRequest(url, { headers, base64: true, timeoutMs: TIMEOUT })
  if (r.status !== 200 || !r.bodyBase64) return { image: null, error: httpErrorMessage(r) }
  return { image: frameos.image({ base64: r.bodyBase64 }) }
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
    .map((l, i) => `<text x="${size}" y="${size * 2 + i * Math.round(size * 1.35)}" font-family="Ubuntu" font-size="${size}" fill="#111111">${esc(l)}</text>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>${text}</svg>`
}

export function get(app: FrameOSApp, context: FrameOSContext): unknown {
  const width = context.imageWidth || app.frame.width
  const height = context.imageHeight || app.frame.height
  const fail = (message: string): unknown => {
    frameos.error(message)
    return frameos.svg(errorPanel(width, height, message), { width, height })
  }
  const c = app.config
  const mode = String(c.mode ?? '').trim() || 'random'
  const albumId = String(c.albumId ?? '').trim()
  const personId = String(c.personId ?? '').trim()
  const metadataStateKey = String(c.metadataStateKey ?? '').trim()
  const saveAssets = String(c.saveAssets ?? 'auto')
  const previewSize = c.previewSize === 'fullsize' ? 'fullsize' : 'preview'

  const serverUrl = normalizeServerUrl(frameos.getSetting('immich', 'url'))
  if (!serverUrl) return fail('Please provide an Immich server URL in the settings.')
  const apiKey = String(frameos.getSetting('immich', 'apiKey') ?? '')
  if (!apiKey) return fail('Please provide an Immich API key in the settings.')
  if (mode === 'album' && !albumId) return fail("Please provide an album ID. It's the UUID visible in the album's URL.")

  let picked: Picked
  if (mode === 'album') {
    picked = fetchRandomAsset(serverUrl, apiKey, albumId, '', false, "This album contains no images. Double-check the album ID. It's the UUID in the album's URL.")
  } else if (mode === 'memories') {
    const r = request(apiKey, `${serverUrl}/api/memories?for=${todayIso()}`)
    let asset: Asset | null = null
    if (r.status === 200) asset = pickRandomAsset(memoriesImageAssets(parse(r.body)))
    else frameos.log(`No Immich memories for today (${httpErrorMessage(r)}), showing a random image instead.`)
    picked = asset ? { asset, message: '' } : fetchRandomAsset(serverUrl, apiKey)
  } else if (mode === 'favorites') {
    picked = fetchRandomAsset(serverUrl, apiKey, '', '', true, 'No favorite images found in Immich.')
  } else {
    picked = fetchRandomAsset(serverUrl, apiKey, '', personId)
  }
  const asset = picked.asset
  if (!asset) return fail(picked.message)
  if (!asset.id) return fail('Immich returned an asset without an ID.')

  const saveAsset =
    saveAssets === 'auto' || saveAssets === 'always'
      ? { name: assetBaseName(asset), extension: assetFileExtension(asset, previewSize), mode: saveAssets }
      : null
  frameos.log(`Showing Immich asset ${asset.id} (${asset.originalFileName ?? 'unnamed'}, ${previewSize})`)
  const photo = downloadPhoto(assetDownloadUrl(serverUrl, asset.id, previewSize), apiKey, saveAsset)
  if (!photo.image) return fail(`Error fetching image from Immich: ${photo.error ?? 'no image'}`)
  if (metadataStateKey) frameos.setState(metadataStateKey, assetMetadata(asset))
  return photo.image
}
