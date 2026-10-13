// A random image from one of the galleries on gallery.frameos.net. The image
// goes through frameos.fetchImage (native decode, straight into the canvas on
// an ESP32).

const BASE_URL = 'https://gallery.frameos.net/image'

export function resolvedCategory(category: unknown, categoryOther: unknown): string {
  const picked = String(category ?? '').trim() || 'cute'
  return picked === 'other' ? String(categoryOther ?? '').trim() : picked
}

// categoryOther is free text: a space or `&` must not break the URL.
export function galleryUrl(category: string): string {
  return `${BASE_URL}?category=${encodeURIComponent(category)}`
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
  const category = resolvedCategory(app.config.category, app.config.categoryOther)
  if (!category) return fail('Please enter the name of a gallery under "Category (if other)".')

  frameos.log(`FrameOS Gallery category: ${category}`)
  const photo = frameos.fetchImage(galleryUrl(category))
  if (!photo.image) return fail(`An error occurred while downloading the gallery image. ${photo.error ?? 'unknown error'}`)
  return photo.image
}
