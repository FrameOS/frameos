// Photo album: plays an album from FrameOS Photos through its share link
// (docs/photos.md, "Share routes"). One photo per render. The position lives
// in a scene state field: on an ESP32 the JS heap does not outlive a render.

const ORDERS = ['random', 'sequential', 'newest', 'oldest']

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
  const key = String(app.config.counterStateKey ?? '').trim()
  const index = key ? position(app.state[key]) : Math.floor(Math.random() * 1000000)

  const r = frameos.httpRequest(`${link}/photo?order=${order}&index=${index}`, { timeoutMs: 20000 })
  if (r.status === 404) return fail('This album link no longer works.')
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
    frameos.log('This album has no photos yet.')
    return show('This album has no photos yet.')
  }

  // Move on before the download, so one broken photo cannot stall the frame.
  if (key) frameos.setState(key, index + 1)
  const name = String(photo.name || photo.path || 'a photo')
  const url = photoUrl(link, photo.url)
  if (!url) return fail(`The album sent no address for ${name}.`)
  frameos.log(`Showing ${name} (${(index % count) + 1} of ${count})`)
  // null, not undefined: no profile clears the last photo's palette
  const result = frameos.fetchImage(url, { colors: photo.colors ?? null })
  if (!result.image) return fail(`Could not load ${name}: ${result.error ?? 'no image'}`)
  return result.image
}
