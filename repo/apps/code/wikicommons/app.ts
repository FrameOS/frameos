// Wikimedia Commons: today's Picture of the Day, the Picture of the Day from
// this date in an earlier year, a random earlier Picture of the Day, or a
// random Commons file. The API calls go through frameos.httpRequest; the
// image itself through frameos.fetchImage (native decode, straight into the
// canvas on an ESP32).

const API_URL = 'https://commons.wikimedia.org/w/api.php'
const USER_AGENT = 'FrameOS Wikimedia Commons app (https://github.com/FrameOS/frameos)'
const FIRST_POTD_YEAR = 2008
const EMBEDDED_THUMBNAIL_WIDTH = 900
const RANDOM_ATTEMPTS = 10
const TIMEOUT = 60000

export type CommonsDate = { year: number; month: number; day: number }
export type CommonsImage = {
  title: string
  imageUrl: string
  pageUrl: string
  description: string
  author: string
  license: string
  mime: string
}

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

export function queryString(params: [string, string][]): string {
  return params.map(([key, value]) => `${encodeUrl(key)}=${encodeUrl(value)}`).join('&')
}

// JsonNode.getStr(default): the value when it is a string, the default otherwise.
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function text(value: unknown, fallback: string): string {
  return value === undefined || value === null ? fallback : String(value)
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function replaceAll(value: string, search: string, replacement: string): string {
  return value.split(search).join(replacement)
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  if ([1, 3, 5, 7, 8, 10, 12].includes(month)) return 31
  if ([4, 6, 9, 11].includes(month)) return 30
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return 0
}

// Local where the frame has a time zone, UTC otherwise.
export function todayDate(now: Date = new Date()): CommonsDate {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
}

export function dateString(date: CommonsDate): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`
}

// Nim's rand(lo..hi): both ends included.
export function randomInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

export function randomPreviousDate(today: CommonsDate): CommonsDate {
  const year = randomInt(FIRST_POTD_YEAR, today.year)
  const month = randomInt(1, year === today.year ? today.month : 12)
  let maxDay = daysInMonth(year, month)
  if (year === today.year && month === today.month) maxDay = Math.min(maxDay, today.day)
  return { year, month, day: randomInt(1, maxDay) }
}

export function randomOnThisDay(today: CommonsDate): CommonsDate {
  const maxYear = Math.max(FIRST_POTD_YEAR, today.year - 1)
  for (let i = 0; i < 100; i++) {
    const year = randomInt(FIRST_POTD_YEAR, maxYear)
    if (today.day <= daysInMonth(year, today.month)) return { year, month: today.month, day: today.day }
  }
  throw new Error('No previous Wikimedia Commons picture of the day exists for this date.')
}

export function stripHtml(value: string): string {
  let inTag = false
  let out = ''
  for (const ch of value) {
    if (ch === '<') inTag = true
    else if (ch === '>') inTag = false
    else if (!inTag) out += ch
  }
  out = replaceAll(out, '&quot;', '"')
  out = replaceAll(out, '&amp;', '&')
  out = replaceAll(out, '&#039;', "'")
  out = replaceAll(out, '&apos;', "'")
  out = replaceAll(out, '&lt;', '<')
  out = replaceAll(out, '&gt;', '>')
  return strip(out)
}

function metadataValue(info: Record<string, any>, key: string): string {
  const metadata = info.extmetadata
  if (isObject(metadata) && key in metadata)
    return stripHtml(str(isObject(metadata[key]) ? metadata[key].value : undefined))
  return ''
}

export function imageExtension(image: { imageUrl: string; mime: string }): string {
  const urlPath = image.imageUrl.split('?')[0].replace(/[A-Z]/g, (c) => c.toLowerCase())
  for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']) {
    if (urlPath.endsWith(ext)) return ext === '.jpeg' ? '.jpg' : ext
  }
  const byMime: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  }
  return byMime[image.mime] ?? '.img'
}

// One page of a query, slimmed to what the render keeps: a parsed response
// costs many times its JSON size on the heap.
export function imageFromPage(page: unknown): CommonsImage | null {
  if (!isObject(page)) return null
  const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] : undefined
  if (!isObject(info)) return null
  const mime = str(info.mime)
  if (!mime.startsWith('image/')) return null
  const imageUrl = str(info.thumburl, str(info.url, ''))
  if (imageUrl === '') return null
  const description = metadataValue(info, 'ImageDescription')
  return {
    title: str(page.title),
    imageUrl,
    pageUrl: str(info.descriptionurl),
    description: description !== '' ? description : metadataValue(info, 'ObjectName'),
    author: metadataValue(info, 'Artist'),
    license: metadataValue(info, 'LicenseShortName'),
    mime,
  }
}

export function firstImageFromQuery(json: unknown): CommonsImage {
  const pages = isObject(json) && isObject(json.query) ? json.query.pages : undefined
  if (Array.isArray(pages)) {
    for (const page of pages) {
      const image = imageFromPage(page)
      if (image) return image
    }
  }
  throw new Error('No supported image returned from Wikimedia Commons.')
}

// The four modes, plus the aliases older configs used (mode "potd" with a
// submode, mode "random").
export function normalizedMode(mode: string, submode: string): string {
  if (mode === '' || mode === 'potd' || mode === 'pictureOfTheDay') {
    if (submode === '' || submode === 'day') return 'pictureOfTheDay'
    if (submode === 'onthisday' || submode === 'onThisDay') return 'onThisDay'
    if (['month', 'random', 'randomPotd', 'randomPictureOfTheDay'].includes(submode)) return 'randomPictureOfTheDay'
    return mode
  }
  if (mode === 'random') return 'randomImage'
  return mode
}

// Thumbnails as wide as the longer side; an ESP32 asks for at most 900 px.
export function thumbnailWidth(width: number, height: number, embedded: boolean): number {
  const result = Math.max(width, height, 1)
  return embedded ? Math.min(result, EMBEDDED_THUMBNAIL_WIDTH) : result
}

export function potdParams(date: CommonsDate, thumbWidth: number): [string, string][] {
  return [
    ['action', 'query'],
    ['generator', 'images'],
    ['titles', `Template:Potd/${dateString(date)}`],
    ['gimlimit', '20'],
    ['prop', 'imageinfo'],
    ['iiprop', 'url|mime|size|extmetadata'],
    ['iiurlwidth', String(thumbWidth)],
  ]
}

export function randomParams(thumbWidth: number): [string, string][] {
  return [
    ['action', 'query'],
    ['generator', 'random'],
    ['grnnamespace', '6'],
    ['grnlimit', '20'],
    ['prop', 'imageinfo'],
    ['iiprop', 'url|mime|size|extmetadata'],
    ['iiurlwidth', String(thumbWidth)],
  ]
}

export function apiUrl(params: [string, string][]): string {
  return `${API_URL}?${queryString([['format', 'json'], ['formatversion', '2'], ...params])}`
}

// Throws on a transport failure, an HTTP error, a body that is not JSON or
// an API error object, like the Nim app's fetchCommonsJson.
function fetchCommonsImage(params: [string, string][]): CommonsImage {
  const r = frameos.httpRequest(apiUrl(params), {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    timeoutMs: TIMEOUT,
  })
  if (r.status === 0) throw new Error(r.error ?? 'request failed')
  if (r.status >= 400) throw new Error(`Wikimedia Commons API HTTP ${r.status}`)
  const json = JSON.parse(r.body ?? '')
  if (isObject(json) && 'error' in json) {
    const error = json.error
    throw new Error(
      `Wikimedia Commons API error: ${str(isObject(error) ? error.info : undefined, JSON.stringify(error))}`
    )
  }
  return firstImageFromQuery(json)
}

function retried(what: string, attempt: () => CommonsImage): CommonsImage {
  let lastError = ''
  for (let i = 0; i < RANDOM_ATTEMPTS; i++) {
    try {
      return attempt()
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(`Could not find a random Wikimedia Commons ${what}: ${lastError}`)
}

export function fetchImageForMode(mode: string, submode: string, thumbWidth: number): CommonsImage {
  const today = todayDate()
  switch (normalizedMode(mode, submode)) {
    case 'pictureOfTheDay':
      return fetchCommonsImage(potdParams(today, thumbWidth))
    case 'onThisDay':
      return fetchCommonsImage(potdParams(randomOnThisDay(today), thumbWidth))
    case 'randomPictureOfTheDay':
      return retried('picture of the day', () => fetchCommonsImage(potdParams(randomPreviousDate(today), thumbWidth)))
    case 'randomImage':
      return retried('image', () => fetchCommonsImage(randomParams(thumbWidth)))
    default:
      throw new Error(`Invalid Wikimedia Commons mode: ${mode}`)
  }
}

// The size the image is for: the context image, else the frame as rendered.
export function contextSize(app: FrameOSApp, context: FrameOSContext): [number, number] {
  if (context.imageWidth && context.imageHeight) return [context.imageWidth, context.imageHeight]
  const { width, height, rotate } = app.frame
  return rotate === 90 || rotate === 270 ? [height, width] : [width, height]
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
  const mode = strip(text(c.mode, 'pictureOfTheDay'))
  const submode = strip(text(c.submode, ''))
  const metadataStateKey = strip(text(c.metadataStateKey, ''))
  const saveAssets = text(c.saveAssets, 'auto')

  let image: CommonsImage
  try {
    image = fetchImageForMode(mode, submode, thumbnailWidth(width, height, !!app.frame.embedded))
  } catch (e) {
    return fail(`Error fetching image from Wikimedia Commons: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (app.frame.debug) frameos.log(`Downloading Wikimedia Commons image: ${image.imageUrl}`)
  const photo = frameos.fetchImage(image.imageUrl, {
    headers: { 'User-Agent': USER_AGENT },
    saveAsset:
      saveAssets === 'auto' || saveAssets === 'always'
        ? { name: replaceAll(image.title, 'File:', ''), extension: imageExtension(image), mode: saveAssets }
        : undefined,
  })
  if (!photo.image) return fail(`Error fetching image from Wikimedia Commons: ${photo.error ?? 'no image'}`)

  if (metadataStateKey) {
    frameos.setState(metadataStateKey, {
      source: 'wikimedia-commons',
      mode: normalizedMode(mode, submode),
      title: image.title,
      description: image.description,
      author: image.author,
      license: image.license,
      pageUrl: image.pageUrl,
      imageUrl: image.imageUrl,
      mime: image.mime,
    })
  }
  return photo.image
}
