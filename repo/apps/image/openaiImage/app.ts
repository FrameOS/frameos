// OpenAI image: one generation over frameos.httpRequest, its base64 or URL image through frameos.fetchImage.
const D = '1024x1024'
const GPT = [D, '1536x1024', '1024x1536']
const SIZES = {
  'dall-e-3': [D, '1792x1024', '1024x1792'],
  'dall-e-2': ['256x256', '512x512', D],
  'gpt-image-2': [...GPT, '1024x640', '640x1024'],
  'gpt-image-1': GPT,
  'gpt-image-1.5': GPT,
}

export function get(app, context) {
  const { prompt, model, size: wanted, style, quality, metadataStateKey, saveAssets } = app.config
  if (!prompt) throw new Error('No prompt provided in app config.')
  const apiKey = frameos.getSetting('openAI', 'apiKey')
  if (!apiKey) throw new Error('Please provide an OpenAI API key in the settings.')

  const { width, height, rotate, embedded } = app.frame
  let wide = (width - height) * (rotate % 180 ? -1 : 1)
  if (context.imageWidth) wide = context.imageWidth - context.imageHeight
  const sizes = SIZES[model] ?? []
  const i = model === 'gpt-image-2' && embedded ? 3 : 1
  let size = D
  if (wanted !== 'best for orientation') size = sizes.includes(wanted) ? wanted : D
  else if (wide && model !== 'dall-e-2') size = sizes[wide > 0 ? i : i + 1] ?? D

  const body = { prompt, n: 1, size, model }
  if (model === 'dall-e-3') {
    if (style) body.style = style
    if (quality) body.quality = quality
  } else if (model.startsWith('gpt-image-')) {
    let { outputFormat: format, outputCompression: compression } = app.config
    if (['low', 'medium', 'high', 'auto'].includes(quality)) body.quality = quality
    if (embedded) {
      body.quality = 'low'
      if (!format || format === 'auto') format = 'jpeg'
      if (!(compression > 0)) compression = 50
    }
    if (['jpeg', 'png', 'webp'].includes(format)) body.output_format = format
    if (['jpeg', 'webp'].includes(format) && compression > 0) body.output_compression = Math.min(compression, 100)
  }

  let r = frameos.httpRequest('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 300000,
  })
  const fail = (message) => {
    throw new Error(`Error fetching image from OpenAI: ${message}`)
  }
  if (!r.status) fail(r.error)
  if (r.status !== 200) {
    let detail = r.body
    try {
      const json = JSON.parse(r.body)
      const e = json?.error
      detail = typeof e?.message === 'string' ? e.message : typeof e === 'string' ? e : JSON.stringify(json)
    } catch {}
    throw new Error(`Error making request ${r.status}: ${detail}`)
  }
  let image
  try {
    image = JSON.parse(r.body)?.data?.[0] ?? {}
  } catch (e) {
    fail(e.message)
  }
  r = null
  const revisedPrompt = image.revised_prompt || undefined
  let source = image.b64_json ? `data:image/${body.output_format ?? 'png'};base64,${image.b64_json}` : image.url
  image = null
  if (!source) throw new Error('No image data returned from OpenAI.')
  const photo = frameos.fetchImage(source, { saveAsset: { name: prompt, extension: 'jpg', mode: saveAssets } })
  source = null
  if (!photo.image) fail(photo.error)
  const meta = { source: 'openai', prompt, generatedPrompt: revisedPrompt || prompt, model, size, revisedPrompt }
  if (metadataStateKey) frameos.setState(metadataStateKey, meta)
  return photo.image
}
