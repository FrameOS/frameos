// Immich photo app. JSON over frameos.httpRequest; the photo itself goes
// through frameos.fetchImage (native decode, straight into the canvas on an
// ESP32).

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

// The flat search fields (albumIds, personIds, ...) AND an owner filter: only
// the key's user and their timeline partners. A shared album's photos owned by
// anyone else never match. Immich 3.2's structured `filter` searches an album
// whole (access-checked), so album mode uses it there and the album timeline
// before that.
export function albumSearchBody(albumId: string): Record<string, unknown> {
  return { size: 1, withExif: true, withPeople: true, filter: { type: { eq: 'IMAGE' }, albumIds: { any: [albumId] } } }
}

export function supportsFilterSearch(version: unknown): boolean {
  const v = version as { major?: unknown; minor?: unknown } | null
  if (!v || typeof v.major !== 'number' || typeof v.minor !== 'number') return false
  return v.major > 3 || (v.major === 3 && v.minor >= 2)
}

// Pick a bucket weighted by its asset count.
export function pickTimeBucket(buckets: unknown, random = Math.random()): string {
  if (!Array.isArray(buckets)) return ''
  const valid = buckets.filter((b) => b && typeof b.timeBucket === 'string' && typeof b.count === 'number' && b.count > 0)
  const total = valid.reduce((sum, b) => sum + b.count, 0)
  let target = random * total
  for (const b of valid) {
    if (target < b.count) return b.timeBucket
    target -= b.count
  }
  return valid.length ? valid[valid.length - 1].timeBucket : ''
}

// A time bucket is columnar: parallel arrays, `isImage` beside `id`.
export function bucketImageIds(bucket: unknown): string[] {
  const b = bucket as { id?: unknown; isImage?: unknown } | null
  if (!b || !Array.isArray(b.id)) return []
  const isImage = Array.isArray(b.isImage) ? b.isImage : null
  return b.id.filter((id, i) => typeof id === 'string' && id && (!isImage || isImage[i] === true))
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

function fetchAlbumAsset(serverUrl: string, apiKey: string, albumId: string): Picked {
  const empty = "This album contains no images. Double-check the album ID. It's the UUID in the album's URL."
  const version = request(apiKey, `${serverUrl}/api/server/version`)
  if (version.status === 200 && supportsFilterSearch(parse(version.body))) {
    const r = request(apiKey, `${serverUrl}/api/search/random`, 'POST', JSON.stringify(albumSearchBody(albumId)))
    if (r.status !== 200) return { asset: null, message: `Error fetching a random image from Immich: ${httpErrorMessage(r)}` }
    const assets = imageAssets(parse(r.body))
    frameos.log(`Immich album search (album ${albumId}, all owners): HTTP ${r.status}, ${assets.length} image candidate(s)`)
    return assets.length ? { asset: pickRandomAsset(assets), message: '' } : { asset: null, message: empty }
  }

  const album = encodeURIComponent(albumId)
  const buckets = request(apiKey, `${serverUrl}/api/timeline/buckets?albumId=${album}`)
  if (buckets.status === 404) {
    frameos.log('This Immich server has no album timeline; searching the album instead, which only finds photos the API key owner or their partners own.')
    return fetchRandomAsset(serverUrl, apiKey, albumId, '', false, empty)
  }
  if (buckets.status !== 200) return { asset: null, message: `Error reading the Immich album: ${httpErrorMessage(buckets)}` }
  const bucketList = parse(buckets.body)
  // A bucket can hold only videos; a few draws find the photos.
  for (let attempt = 0; attempt < 3; attempt++) {
    const timeBucket = pickTimeBucket(bucketList)
    if (!timeBucket) break
    const r = request(apiKey, `${serverUrl}/api/timeline/bucket?albumId=${album}&timeBucket=${encodeURIComponent(timeBucket)}`)
    if (r.status !== 200) return { asset: null, message: `Error reading the Immich album: ${httpErrorMessage(r)}` }
    const ids = bucketImageIds(parse(r.body))
    frameos.log(`Immich album timeline (album ${albumId}, bucket ${timeBucket}): HTTP ${r.status}, ${ids.length} image candidate(s)`)
    if (!ids.length) continue
    const id = ids[Math.floor(Math.random() * ids.length)]
    const detail = request(apiKey, `${serverUrl}/api/assets/${encodeURIComponent(id)}`)
    const parsed = detail.status === 200 ? parse(detail.body) : null
    return { asset: parsed && typeof parsed === 'object' ? slim(parsed as Record<string, any>) : { id }, message: '' }
  }
  return { asset: null, message: empty }
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
    picked = fetchAlbumAsset(serverUrl, apiKey, albumId)
  } else if (mode === 'memories') {
    const date = todayIso()
    const r = request(apiKey, `${serverUrl}/api/memories?for=${date}`)
    let asset: Asset | null = null
    if (r.status === 200) {
      const assets = memoriesImageAssets(parse(r.body))
      frameos.log(`Immich memories for ${date}: HTTP 200, ${assets.length} image candidate(s)`)
      asset = pickRandomAsset(assets)
    } else frameos.log(`No Immich memories for today (${httpErrorMessage(r)}), showing a random image instead.`)
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
      : undefined
  frameos.log(`Showing Immich asset ${asset.id} (${asset.originalFileName ?? 'unnamed'}, ${previewSize})`)
  const photo = frameos.fetchImage(assetDownloadUrl(serverUrl, asset.id, previewSize), {
    headers: { 'x-api-key': apiKey },
    saveAsset,
  })
  if (!photo.image) return fail(`Error fetching image from Immich: ${photo.error ?? 'no image'}`)
  if (metadataStateKey) frameos.setState(metadataStateKey, assetMetadata(asset))
  return photo.image
}
