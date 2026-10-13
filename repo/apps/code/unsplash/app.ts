// A random Unsplash photo for a search. The API call goes through
// frameos.httpRequest; the photo itself through frameos.fetchImage (native
// decode, straight into the canvas on an ESP32).

const API_URL = 'https://api.unsplash.com/photos/random/'
const TIMEOUT = 60000

type Json = Record<string, any>

// Nim's strutils.strip: ASCII whitespace only.
export function strip(value: string): string {
  return value.replace(/^[ \t\v\r\n\f]+|[ \t\v\r\n\f]+$/g, '')
}

// Nim's uri.encodeUrl: everything but A-Z a-z 0-9 - . _ ~ is %XX, a space is '+'.
export function encodeUrl(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+')
}

// JsonNode.getStr(default): the value when it is a string, the default otherwise.
export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function text(value: unknown, fallback: string): string {
  return value === undefined || value === null ? fallback : String(value)
}

// The size the image is for: the context image, else the frame as rendered.
export function contextSize(app: FrameOSApp, context: FrameOSContext): [number, number] {
  if (context.imageWidth && context.imageHeight) return [context.imageWidth, context.imageHeight]
  const { width, height, rotate } = app.frame
  return rotate === 90 || rotate === 270 ? [height, width] : [width, height]
}

export function resolvedOrientation(orientation: string, width: number, height: number): string {
  if (orientation === 'auto') return height > width ? 'portrait' : width > height ? 'landscape' : 'squarish'
  if (orientation === 'any') return ''
  return orientation
}

export function apiUrl(orientation: string, search: string): string {
  return `${API_URL}?orientation=${encodeUrl(orientation)}&query=${encodeUrl(search)}`
}

// Unsplash's raw URL already carries a query string (?ixid=...).
export function photoUrl(rawUrl: string, width: number, height: number): string {
  return `${rawUrl}&w=${width}&h=${height}&fit=crop&crop=faces,edges`
}

// "Error making request <status>: <error.message | error | the body>".
export function requestErrorMessage(status: number, body: string): string {
  let detail: string
  try {
    const json = JSON.parse(body)
    const error = json && typeof json === 'object' && !Array.isArray(json) ? json.error : undefined
    const nested = error && typeof error === 'object' && !Array.isArray(error) ? error.message : undefined
    detail = str(nested, str(error, JSON.stringify(json)))
  } catch {
    detail = body
  }
  return `Error making request ${status}: ${detail}`
}

function field(json: Json, ...path: string[]): unknown {
  let node: any = json
  for (const key of path) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
    node = node[key]
  }
  return node
}

export function photoMetadata(
  json: Json,
  search: string,
  orientation: string,
  imageUrl: string
): Record<string, string> {
  const description = str(json.description, str(json.alt_description, ''))
  return {
    source: 'unsplash',
    search,
    orientation,
    imageUrl,
    id: str(json.id),
    title: str(json.slug, description),
    description,
    altDescription: str(json.alt_description),
    location: str(field(json, 'location', 'name')),
    createdAt: str(json.created_at),
    photoUrl: str(field(json, 'links', 'html')),
    author: str(field(json, 'user', 'name')),
    authorUsername: str(field(json, 'user', 'username')),
    authorUrl: str(field(json, 'user', 'links', 'html')),
  }
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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
  const body = lines
    .map(
      (l, i) =>
        `<text x="${size}" y="${
          size * 2 + i * Math.round(size * 1.35)
        }" font-family="Ubuntu" font-size="${size}" fill="#111111">${esc(l)}</text>`
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>${body}</svg>`
}

export function get(app: FrameOSApp, context: FrameOSContext): unknown {
  const [width, height] = contextSize(app, context)
  const fail = (message: string): unknown => {
    frameos.error(message)
    return frameos.svg(errorPanel(width, height, message), { width, height })
  }
  const c = app.config
  const search = strip(text(c.search, 'nature'))
  const metadataStateKey = strip(text(c.metadataStateKey, ''))
  const saveAssets = text(c.saveAssets, 'auto')

  const apiKey = str(frameos.getSetting('unsplash', 'accessKey'))
  if (apiKey === '') return fail('Please provide an Unsplash API key in the settings.')

  const orientation = resolvedOrientation(text(c.orientation, 'auto'), width, height)
  const url = apiUrl(orientation, search)
  if (app.frame.debug) frameos.log(`API request: ${url}`)
  const response = frameos.httpRequest(url, {
    headers: { Authorization: `Client-ID ${apiKey}`, 'Accept-Version': 'v1', 'Content-Type': 'application/json' },
    timeoutMs: TIMEOUT,
  })
  if (response.status === 0) return fail(`Error fetching image from Unsplash: ${response.error ?? 'request failed'}`)
  if (response.status !== 200) return fail(requestErrorMessage(response.status, response.body ?? ''))

  let json: Json
  try {
    const parsed = JSON.parse(response.body ?? '')
    json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (e) {
    return fail(`Error fetching image from Unsplash: ${e instanceof Error ? e.message : String(e)}`)
  }
  const rawUrl = str(field(json, 'urls', 'raw'))
  if (rawUrl === '') return fail('No image URL returned from Unsplash.')
  const imageUrl = photoUrl(rawUrl, width, height)
  // Keep only what the metadata needs; the parsed response can go.
  const metadata = metadataStateKey ? photoMetadata(json, search, orientation, imageUrl) : null
  json = {}

  if (app.frame.debug) frameos.log(`Downloading image: ${imageUrl}`)
  const photo = frameos.fetchImage(imageUrl, {
    saveAsset:
      saveAssets === 'auto' || saveAssets === 'always'
        ? { name: `${search} ${width}x${height}`, extension: '.jpg', mode: saveAssets }
        : undefined,
  })
  if (!photo.image) return fail(`Error fetching image from Unsplash: ${photo.error ?? 'no image'}`)
  if (metadata) frameos.setState(metadataStateKey, metadata)
  return photo.image
}
