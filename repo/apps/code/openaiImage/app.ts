// OpenAI image app. The generation request goes through frameos.httpRequest;
// the image it returns (base64 for the gpt-image models, a URL for dall-e)
// through frameos.fetchImage (native decode, straight into the canvas on an
// ESP32).

const API_URL = 'https://api.openai.com/v1/images/generations'
// Image generation is slow: up to a few minutes at high quality.
const TIMEOUT = 300000
const DEFAULT_SIZE = '1024x1024'
const GPT_IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto']
const OUTPUT_FORMATS = ['jpeg', 'png', 'webp']

type Response = { status: number; body?: string; error?: string }
export type ImageOptions = {
  prompt: string
  model: string
  style: string
  quality: string
  outputFormat: string
  outputCompression: number
}
export type ImageReply = { b64: string; url: string; revisedPrompt: string }

// Config values the way the Nim app read them: a string field keeps its
// default unless the config holds a string; an integer field takes a number
// (truncated) or a string of digits.
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function int(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) return parseInt(value.trim(), 10)
  return fallback
}

export function isGptImageModel(model: string): boolean {
  return model.startsWith('gpt-image-')
}

// The sizes each model accepts, as an explicit `size` is checked against.
export function modelSizes(model: string): string[] {
  switch (model) {
    case 'dall-e-3':
      return ['1024x1024', '1792x1024', '1024x1792']
    case 'dall-e-2':
      return ['256x256', '512x512', '1024x1024']
    case 'gpt-image-2':
      return ['1024x640', '640x1024', '1024x1024', '1536x1024', '1024x1536']
    case 'gpt-image-1':
    case 'gpt-image-1.5':
      return ['1024x1024', '1536x1024', '1024x1536']
    default:
      return []
  }
}

function byOrientation(width: number, height: number, landscape: string, portrait: string): string {
  return width > height ? landscape : width < height ? portrait : DEFAULT_SIZE
}

// The size to ask for. "best for orientation" follows the shape being drawn
// into; an ESP32 asks gpt-image-2 for its smallest sizes. An explicit size the
// model does not offer falls back to 1024x1024.
export function imageSize(model: string, size: string, width: number, height: number, embedded = false): string {
  if (size === 'best for orientation') {
    switch (model) {
      case 'dall-e-3':
        return byOrientation(width, height, '1792x1024', '1024x1792')
      case 'gpt-image-2':
        return embedded
          ? byOrientation(width, height, '1024x640', '640x1024')
          : byOrientation(width, height, '1536x1024', '1024x1536')
      case 'gpt-image-1':
      case 'gpt-image-1.5':
        return byOrientation(width, height, '1536x1024', '1024x1536')
      default:
        return DEFAULT_SIZE
    }
  }
  if (size !== '') return modelSizes(model).includes(size) ? size : DEFAULT_SIZE
  return DEFAULT_SIZE
}

// The generation request. An ESP32 always asks the gpt-image models for low
// quality and a compressed JPEG unless told otherwise: the base64 reply lands
// in a few MB of heap.
export function requestBody(options: ImageOptions, size: string, embedded = false): Record<string, unknown> {
  const { prompt, model, style, quality, outputFormat, outputCompression } = options
  const body: Record<string, unknown> = { prompt, n: 1, size, model }
  if (model === 'dall-e-3') {
    if (style !== '') body.style = style
    if (quality !== '') body.quality = quality
  } else if (isGptImageModel(model)) {
    if (GPT_IMAGE_QUALITIES.includes(quality)) body.quality = quality
    if (embedded) {
      body.quality = 'low'
      const format = outputFormat === '' || outputFormat === 'auto' ? 'jpeg' : outputFormat
      if (OUTPUT_FORMATS.includes(format)) body.output_format = format
      if (format === 'jpeg' || format === 'webp') {
        const compression = outputCompression > 0 ? outputCompression : 50
        body.output_compression = Math.min(Math.max(compression, 0), 100)
      }
    } else {
      if (OUTPUT_FORMATS.includes(outputFormat)) body.output_format = outputFormat
      if ((outputFormat === 'jpeg' || outputFormat === 'webp') && outputCompression > 0) {
        body.output_compression = Math.min(Math.max(outputCompression, 0), 100)
      }
    }
  }
  return body
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// `error.message`, else a string `error`, else the whole reply as JSON; the raw
// body when it is not JSON.
export function apiErrorDetail(body: string): string {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return body
  }
  const error = isObject(json) ? json.error : undefined
  const message = isObject(error) ? error.message : undefined
  if (typeof message === 'string') return message
  if (typeof error === 'string') return error
  return JSON.stringify(json)
}

// The first generated image. Throws on a body that is not JSON. Only the
// strings are kept: the parsed reply is freed as soon as this returns.
export function parseImageReply(body: string): ImageReply {
  const json: unknown = JSON.parse(body)
  const data = isObject(json) ? json.data : undefined
  const node = Array.isArray(data) && isObject(data[0]) ? data[0] : {}
  return { b64: str(node.b64_json, ''), url: str(node.url, ''), revisedPrompt: str(node.revised_prompt, '') }
}

export function imageMetadata(
  prompt: string,
  revisedPrompt: string,
  model: string,
  size: string
): Record<string, string> {
  const metadata: Record<string, string> = {
    source: 'openai',
    prompt,
    generatedPrompt: revisedPrompt !== '' ? revisedPrompt : prompt,
    model,
    size,
  }
  if (revisedPrompt !== '') metadata.revisedPrompt = revisedPrompt
  return metadata
}

// What is being drawn into: the incoming image, else the frame as rendered
// (a 90/270 rotation swaps its sides).
export function renderSize(
  frame: { width: number; height: number; rotate?: number },
  context: FrameOSContext
): [number, number] {
  if (context.imageWidth && context.imageHeight) return [context.imageWidth, context.imageHeight]
  const rotated = frame.rotate === 90 || frame.rotate === 270
  return rotated ? [frame.height, frame.width] : [frame.width, frame.height]
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

export function get(app: FrameOSApp, context: FrameOSContext): unknown {
  const [width, height] = renderSize(app.frame, context)
  const fail = (message: string): unknown => {
    frameos.error(message)
    return frameos.svg(errorPanel(width, height, message), { width, height })
  }
  const c = app.config
  const prompt = str(c.prompt, '')
  const model = str(c.model, 'gpt-image-2')
  const metadataStateKey = str(c.metadataStateKey, '')
  const saveAssets = str(c.saveAssets, 'auto')
  if (prompt === '') return fail('No prompt provided in app config.')
  const apiKey = str(frameos.getSetting('openAI', 'apiKey'), '')
  if (apiKey === '') return fail('Please provide an OpenAI API key in the settings.')

  const embedded = app.frame.embedded === true
  const size = imageSize(model, str(c.size, 'best for orientation'), width, height, embedded)
  const body = requestBody(
    {
      prompt,
      model,
      style: str(c.style, 'vivid'),
      quality: str(c.quality, 'standard'),
      outputFormat: str(c.outputFormat, 'auto'),
      outputCompression: int(c.outputCompression, 0),
    },
    size,
    embedded
  )
  const format = str(body.output_format, 'png')

  let response: Response | null = frameos.httpRequest(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: TIMEOUT,
  })
  if (response.status === 0) return fail(`Error fetching image from OpenAI: ${response.error ?? 'request failed'}`)
  if (response.status !== 200) {
    return fail(`Error making request ${response.status}: ${apiErrorDetail(response.body ?? '')}`)
  }
  let reply: ImageReply
  try {
    reply = parseImageReply(response.body ?? '')
  } catch (error) {
    return fail(`Error fetching image from OpenAI: ${error instanceof Error ? error.message : String(error)}`)
  }
  // The body holds the whole base64 image: let it go before the decode.
  response = null
  const revisedPrompt = reply.revisedPrompt

  let source = ''
  if (reply.b64 !== '') {
    source = `data:image/${format};base64,${reply.b64}`
    reply.b64 = ''
  } else if (reply.url !== '') {
    source = reply.url
  } else {
    return fail('No image data returned from OpenAI.')
  }
  // Named after the prompt with a .jpg extension, whatever the format, as the
  // Nim app saved it.
  const photo = frameos.fetchImage(source, {
    saveAsset:
      saveAssets === 'auto' || saveAssets === 'always'
        ? { name: prompt, extension: 'jpg', mode: saveAssets }
        : undefined,
  })
  source = ''
  if (!photo.image) return fail(`Error fetching image from OpenAI: ${photo.error ?? 'no image'}`)
  if (metadataStateKey !== '') frameos.setState(metadataStateKey, imageMetadata(prompt, revisedPrompt, model, size))
  return photo.image
}
