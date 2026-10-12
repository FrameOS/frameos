// Immich photo app.
//
// Picks one image from a self-hosted Immich server (the whole library, one
// person, one album, the favorites, or today's memories) and returns it.
// The API calls are plain JSON over frameos.httpRequest; the photo itself
// never crosses the JS heap: frameos.fetchImage downloads and decodes it
// natively, and on an ESP32 streams it straight into the canvas the
// render/image node offered. This is the same path the frame's built-in
// photo apps take, so a 1440 px Immich preview fits a frame with a few MB
// of PSRAM.
//
// Firmware older than frameos.fetchImage falls back to pulling the bytes
// through httpRequest as base64 (fine for preview-sized photos on a Pi).

const REQUEST_TIMEOUT_MS = 30000

type ImmichAsset = {
  id: string
  type?: string
  originalFileName?: string
  isFavorite?: boolean
  exifInfo?: Record<string, unknown> | null
  people?: { name?: string }[] | null
}

type Candidates = { asset: ImmichAsset | null; message: string }

type FetchedPhoto = {
  image: unknown
  width?: number
  height?: number
  error?: string
  savedAs?: string
}

// ---------------------------------------------------------------------------
// URL and request helpers
// ---------------------------------------------------------------------------

export function normalizeServerUrl(url: unknown): string {
  let result = String(url ?? '').trim()
  while (result.endsWith('/')) {
    result = result.slice(0, -1)
  }
  return result
}

export function searchRandomUrl(serverUrl: string): string {
  return `${serverUrl}/api/search/random`
}

// Older servers without POST /api/search/random cannot filter server-side;
// ask for a batch so client-side filtering has image candidates.
export function legacyRandomUrl(serverUrl: string): string {
  return `${serverUrl}/api/assets/random?count=20`
}

export function memoriesUrl(serverUrl: string, isoDate: string): string {
  return `${serverUrl}/api/memories?for=${encodeURIComponent(isoDate)}`
}

export function assetDownloadUrl(serverUrl: string, assetId: string, previewSize: string): string {
  if (previewSize === 'fullsize') {
    return `${serverUrl}/api/assets/${encodeURIComponent(assetId)}/original`
  }
  return `${serverUrl}/api/assets/${encodeURIComponent(assetId)}/thumbnail?size=preview`
}

// The calendar date, as `GET /api/memories?for=` wants it. Immich 3
// validates `for` as a plain YYYY-MM-DD; 1.x and 2.x accept it too. The
// getters are local where the runtime has a zone (an ESP32 with its time
// zone set, a Pi through the system zone, the browser preview) and UTC
// otherwise; a bare date either way.
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function randomSearchBody(albumId = '', personId = '', isFavorite = false): Record<string, unknown> {
  const body: Record<string, unknown> = { size: 1, type: 'IMAGE', withExif: true, withPeople: true }
  if (albumId) {
    body.albumIds = [albumId]
  }
  if (personId) {
    body.personIds = [personId]
  }
  if (isFavorite) {
    body.isFavorite = true
  }
  return body
}

// Keep only what the render needs: a parsed Immich response costs many
// times its JSON size on the heap, and memories can list dozens of assets.
function slimAsset(asset: Record<string, any>): ImmichAsset {
  const slim: ImmichAsset = { id: String(asset.id ?? ''), type: asset.type }
  if (asset.originalFileName) {
    slim.originalFileName = String(asset.originalFileName)
  }
  if (asset.isFavorite) {
    slim.isFavorite = true
  }
  if (asset.exifInfo && typeof asset.exifInfo === 'object') {
    slim.exifInfo = asset.exifInfo
  }
  if (Array.isArray(asset.people)) {
    slim.people = asset.people.map((person: any) => ({ name: person?.name }))
  }
  return slim
}

export function imageAssets(assets: unknown): ImmichAsset[] {
  if (!Array.isArray(assets)) {
    return []
  }
  const result: ImmichAsset[] = []
  for (const asset of assets) {
    if (asset && typeof asset === 'object' && asset.type === 'IMAGE') {
      result.push(slimAsset(asset))
    }
  }
  return result
}

export function memoriesImageAssets(memories: unknown): ImmichAsset[] {
  if (!Array.isArray(memories)) {
    return []
  }
  const result: ImmichAsset[] = []
  for (const memory of memories) {
    if (memory && typeof memory === 'object') {
      for (const asset of imageAssets(memory.assets)) {
        result.push(asset)
      }
    }
  }
  return result
}

export function pickRandomAsset(assets: ImmichAsset[]): ImmichAsset | null {
  if (assets.length === 0) {
    return null
  }
  return assets[Math.floor(Math.random() * assets.length)]
}

const EXIF_KEYS = ['make', 'model', 'fNumber', 'exposureTime', 'iso', 'focalLength', 'dateTimeOriginal']

export function assetMetadata(asset: ImmichAsset): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    source: 'immich',
    id: asset.id ?? '',
    originalFileName: asset.originalFileName ?? '',
  }
  const exif = asset.exifInfo
  if (exif && typeof exif === 'object') {
    for (const key of EXIF_KEYS) {
      if (exif[key] !== undefined && exif[key] !== null) {
        metadata[key] = exif[key]
      }
    }
  }
  if (Array.isArray(asset.people)) {
    const names = asset.people.map((person) => person?.name ?? '').filter((name) => name !== '')
    if (names.length > 0) {
      metadata.people = names
    }
  }
  return metadata
}

// The extension ends up in a path under the assets folder, and
// originalFileName is whatever the Immich server sends. Only a short
// alphanumeric suffix is accepted: no separators, no dots.
export function assetFileExtension(asset: ImmichAsset, previewSize: string): string {
  if (previewSize === 'fullsize') {
    const name = asset.originalFileName ?? ''
    const dot = name.lastIndexOf('.')
    if (dot > 0 && dot < name.length - 1) {
      const ext = name.slice(dot + 1).toLowerCase()
      if (ext.length <= 5 && /^[a-z0-9]+$/.test(ext)) {
        return `.${ext}`
      }
    }
  }
  return '.jpg'
}

export function assetBaseName(asset: ImmichAsset): string {
  let name = asset.originalFileName ?? ''
  const dot = name.lastIndexOf('.')
  if (dot > 0) {
    name = name.slice(0, dot)
  }
  return name !== '' ? name : asset.id || 'immich'
}

export function httpErrorMessage(response: { status: number; body?: string; error?: string }): string {
  if (response.status === 0) {
    return response.error ? `request failed: ${response.error}` : 'request failed'
  }
  let message = `HTTP ${response.status}`
  const body = response.body ?? ''
  try {
    const json = JSON.parse(body)
    const detail = json?.message
    if (typeof detail === 'string' && detail !== '') {
      message += `: ${detail}`
    } else if (Array.isArray(detail) && detail.length > 0) {
      message += `: ${typeof detail[0] === 'string' ? detail[0] : JSON.stringify(detail[0])}`
    } else if (typeof json?.error === 'string' && json.error !== '') {
      message += `: ${json.error}`
    }
  } catch {
    if (body.length > 0 && body.length < 300) {
      message += `: ${body}`
    }
  }
  return message
}

function requestJson(
  apiKey: string,
  url: string,
  method = 'GET',
  body = ''
): { status: number; body?: string; error?: string } {
  return frameos.httpRequest(url, {
    method,
    headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
    body,
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
}

function parseBody(body: string | undefined): unknown {
  try {
    return JSON.parse(body ?? '')
  } catch {
    return null
  }
}

function describeSearch(albumId: string, personId: string, isFavorite: boolean): string {
  if (albumId) {
    return `album ${albumId}`
  }
  if (personId) {
    return `person ${personId}`
  }
  if (isFavorite) {
    return 'favorites'
  }
  return 'whole library'
}

function fetchRandomAsset(
  serverUrl: string,
  apiKey: string,
  albumId = '',
  personId = '',
  isFavorite = false,
  emptyMessage = 'Immich returned no image assets.'
): Candidates {
  let response = requestJson(
    apiKey,
    searchRandomUrl(serverUrl),
    'POST',
    JSON.stringify(randomSearchBody(albumId, personId, isFavorite))
  )
  let usedLegacyFallback = false
  if (response.status === 404) {
    frameos.log(
      'This Immich server lacks POST /api/search/random; falling back to /api/assets/random where album/person/favorite filters cannot be applied.'
    )
    response = requestJson(apiKey, legacyRandomUrl(serverUrl))
    usedLegacyFallback = true
  }
  if (response.status !== 200) {
    return { asset: null, message: `Error fetching a random image from Immich: ${httpErrorMessage(response)}` }
  }
  let assets = imageAssets(parseBody(response.body))
  if (usedLegacyFallback && isFavorite) {
    assets = assets.filter((asset) => asset.isFavorite)
  }
  frameos.log(
    `Immich random search (${describeSearch(albumId, personId, isFavorite)}): HTTP ${response.status}, ${assets.length} image candidate(s)`
  )
  if (assets.length === 0) {
    if (usedLegacyFallback) {
      return { asset: null, message: 'This Immich server returned no matching images from /api/assets/random.' }
    }
    return { asset: null, message: emptyMessage }
  }
  return { asset: pickRandomAsset(assets), message: '' }
}

// ---------------------------------------------------------------------------
// The photo: native download, with a base64 fallback for older firmware
// ---------------------------------------------------------------------------

function downloadPhoto(url: string, apiKey: string, saveAsset: { name: string; extension: string; mode: string } | null): FetchedPhoto {
  const headers = { 'x-api-key': apiKey }
  if (typeof frameos.fetchImage === 'function') {
    return frameos.fetchImage(url, saveAsset ? { headers, saveAsset } : { headers })
  }
  // Firmware before fetchImage (2026.10): the bytes cross the heap as base64,
  // about three times the photo's size. The native path above is the one an
  // ESP32 needs; here a Pi gets the picture, with no asset saved.
  const response = frameos.httpRequest(url, { headers, base64: true, timeoutMs: REQUEST_TIMEOUT_MS })
  if (response.status !== 200 || !response.bodyBase64) {
    return { image: null, error: httpErrorMessage(response) }
  }
  return { image: frameos.image({ base64: response.bodyBase64 }) }
}

// ---------------------------------------------------------------------------
// Error panel: the message on the frame, the way the built-in apps paint it
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function wrapWords(text: string, maxChars: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter((part) => part !== '')) {
    if (line !== '' && line.length + 1 + word.length > maxChars) {
      lines.push(line)
      line = word
    } else {
      line = line === '' ? word : `${line} ${word}`
    }
  }
  if (line !== '') {
    lines.push(line)
  }
  return lines
}

export function errorPanel(width: number, height: number, message: string): string {
  const fontSize = Math.max(14, Math.round(Math.min(width, height) / 24))
  const margin = fontSize
  const lines = wrapWords(message, Math.max(10, Math.floor((width - 2 * margin) / (fontSize * 0.55))))
  const lineHeight = Math.round(fontSize * 1.35)
  const text = lines
    .map(
      (line, index) =>
        `<text x="${margin}" y="${margin + fontSize + index * lineHeight}" font-family="Ubuntu" font-size="${fontSize}" fill="#111111">${escapeXml(line)}</text>`
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>${text}</svg>`
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

export function get(app: FrameOSApp, context: FrameOSContext): unknown {
  const width = context.imageWidth || app.frame.width
  const height = context.imageHeight || app.frame.height
  const fail = (message: string): unknown => {
    frameos.error(message)
    return frameos.svg(errorPanel(width, height, message), { width, height })
  }

  let mode = String(app.config.mode ?? '').trim()
  if (mode === '') {
    mode = 'random'
  }
  const albumId = String(app.config.albumId ?? '').trim()
  const personId = String(app.config.personId ?? '').trim()
  const metadataStateKey = String(app.config.metadataStateKey ?? '').trim()
  const saveAssets = String(app.config.saveAssets ?? 'auto')
  const previewSize = app.config.previewSize === 'fullsize' ? 'fullsize' : 'preview'

  const serverUrl = normalizeServerUrl(frameos.getSetting('immich', 'url'))
  if (serverUrl === '') {
    return fail('Please provide an Immich server URL in the settings.')
  }
  const apiKey = String(frameos.getSetting('immich', 'apiKey') ?? '')
  if (apiKey === '') {
    return fail('Please provide an Immich API key in the settings.')
  }
  if (mode === 'album' && albumId === '') {
    return fail("Please provide an album ID. It's the UUID visible in the album's URL.")
  }

  let picked: Candidates
  if (mode === 'album') {
    // Server-side random pick: albums can be huge and the full asset list
    // would blow the response cap (and ESP32 memory).
    picked = fetchRandomAsset(
      serverUrl,
      apiKey,
      albumId,
      '',
      false,
      "This album contains no images. Double-check the album ID. It's the UUID in the album's URL."
    )
  } else if (mode === 'memories') {
    const response = requestJson(apiKey, memoriesUrl(serverUrl, todayIso()))
    let asset: ImmichAsset | null = null
    if (response.status === 200) {
      asset = pickRandomAsset(memoriesImageAssets(parseBody(response.body)))
    } else {
      frameos.log(`No Immich memories for today (${httpErrorMessage(response)}), showing a random image instead.`)
    }
    picked = asset ? { asset, message: '' } : fetchRandomAsset(serverUrl, apiKey)
  } else if (mode === 'favorites') {
    picked = fetchRandomAsset(serverUrl, apiKey, '', '', true, 'No favorite images found in Immich.')
  } else {
    picked = fetchRandomAsset(serverUrl, apiKey, '', personId)
  }
  if (!picked.asset) {
    return fail(picked.message)
  }

  const asset = picked.asset
  if (!asset.id) {
    return fail('Immich returned an asset without an ID.')
  }

  const saveAsset =
    saveAssets === 'auto' || saveAssets === 'always'
      ? { name: assetBaseName(asset), extension: assetFileExtension(asset, previewSize), mode: saveAssets }
      : null
  frameos.log(`Showing Immich asset ${asset.id} (${asset.originalFileName ?? 'unnamed'}, ${previewSize})`)
  const photo = downloadPhoto(assetDownloadUrl(serverUrl, asset.id, previewSize), apiKey, saveAsset)
  if (!photo.image) {
    return fail(`Error fetching image from Immich: ${photo.error ?? 'no image'}`)
  }

  if (metadataStateKey !== '') {
    frameos.setState(metadataStateKey, assetMetadata(asset))
  }
  return photo.image
}
