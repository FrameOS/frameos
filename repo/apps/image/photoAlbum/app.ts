// Photo album: plays an album from FrameOS Photos through its share link
// (docs/photos.md, "Share routes"). One photo per render. The position lives
// in a scene state field: on an ESP32 the JS heap does not outlive a render.

const ORDERS = ['random', 'sequential', 'newest', 'oldest']
const SHAPES = ['landscape', 'portrait', 'square']

// A shape toggle: off only when it says so (false, or "false" from a state
// field); unset is on, so an older scene plays every photo.
export function shapeOn(value: unknown): boolean {
  return !(value === false || String(value ?? '').trim().toLowerCase() === 'false')
}

// The `shapes=` query for the share route: the shapes that are on, or '' for
// every shape (the server's default, which older servers also give).
export function shapesQuery(config: Record<string, unknown>): string {
  const on = SHAPES.filter((shape) => shapeOn(config[shape]))
  return on.length === SHAPES.length ? '' : `&shapes=${on.join(',')}`
}

// The share link, or '' when it is not an http(s) URL.
export function albumLink(value: unknown): string {
  const link = String(value ?? '').trim().replace(/\/+$/, '')
  return /^https?:\/\/[^\s/?#]+/i.test(link) ? link : ''
}

// scheme://host[:port] of a link. QuickJS has no URL global.
export function linkOrigin(link: string): string {
  const match = /^https?:\/\/[^/?#]+/i.exec(link)
  return match ? match[0] : ''
}

// A photo's address: absolute as is, root-relative against the link's origin.
export function photoUrl(link: string, url: unknown): string {
  const value = String(url ?? '')
  if (/^https?:\/\//i.test(value)) return value
  return value.startsWith('/') ? linkOrigin(link) + value : ''
}

// The counter as a non-negative integer; anything else starts over at 0.
export function position(value: unknown): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function panel(width: number, height: number, message: string): string {
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
  const show = (message: string): unknown => frameos.svg(panel(width, height, message), { width, height })
  const fail = (message: string): unknown => {
    frameos.error(message)
    return show(message)
  }

  const link = albumLink(app.config.album)
  if (!link) return fail('Please add an album link. Make one with Install photo scenes on the Photos page.')
  const order = ORDERS.includes(String(app.config.order)) ? String(app.config.order) : 'random'
  // One photo of the album, by its path, instead of the counter's pick.
  const single = String(app.config.photo ?? '').trim()
  const key = single ? '' : String(app.config.counterStateKey ?? '').trim()
  const index = key ? position(app.state[key]) : Math.floor(Math.random() * 1000000)

  const shapes = single ? '' : shapesQuery(app.config)
  if (shapes === '&shapes=') return fail('Turn on at least one photo shape: landscape, portrait or square.')
  const query = single ? `path=${encodeURIComponent(single)}` : `order=${order}&index=${index}${shapes}`
  const r = frameos.httpRequest(`${link}/photo?${query}`, { timeoutMs: 20000 })
  if (r.status === 404) return fail(single ? 'This photo is no longer in the album.' : 'This album link no longer works.')
  if (r.status !== 200) {
    return fail(r.status ? `Could not load the album (HTTP ${r.status}).` : `Could not reach the album: ${r.error ?? 'no response'}`)
  }
  let data: any = null
  try {
    data = JSON.parse(r.body ?? '')
  } catch {}
  if (!data || typeof data !== 'object') return fail('The album sent an answer this frame could not read.')
  const count = position(data.count)
  const photo = data.photo
  if (!count || !photo || typeof photo !== 'object') {
    const message = shapes ? 'This album has no photos of the chosen shapes.' : 'This album has no photos yet.'
    frameos.log(message)
    return show(message)
  }

  // Move on before the download, so one broken photo cannot stall the frame.
  if (key) frameos.setState(key, index + 1)
  const name = String(photo.name || photo.path || 'a photo')
  const url = photoUrl(link, photo.url)
  if (!url) return fail(`The album sent no address for ${name}.`)
  frameos.log(single ? `Showing ${name}` : `Showing ${name} (${(index % count) + 1} of ${count})`)
  // null, not undefined: no profile clears the last photo's palette
  const result = frameos.fetchImage(url, { colors: photo.colors ?? null })
  if (!result.image) return fail(`Could not load ${name}: ${result.error ?? 'no image'}`)
  return result.image
}
