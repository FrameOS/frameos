import { get } from './app'

const settings = { openAI: { apiKey: 'sk' } }
const generation = (data: Record<string, unknown>) => mock.json({ data: [data] })
const base = { prompt: 'a cat', model: 'gpt-image-2', size: 'best for orientation', quality: 'auto', saveAssets: 'auto' }

function requestBody(http: { calls: any[][] }, index = 0) {
  return JSON.parse(http.calls[index][1].body)
}

describe('openaiImage', () => {
  it('generates one image for the prompt and returns the decoded photo', () => {
    const http = mock.httpRequest(() => generation({ url: 'https://oai/img.png', revised_prompt: 'a fluffy cat' }))
    const fetchImage = mock.fetchImage(() => mock.image())
    const app = makeApp({ settings, config: { ...base, metadataStateKey: 'meta' } })
    expect(get(app, makeContext())).toMatchObject({ __frameosType: 'image' })
    expect(http.calls[0][0]).toBe('https://api.openai.com/v1/images/generations')
    expect(http.calls[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer sk' }, timeoutMs: 300000 })
    expect(requestBody(http)).toEqual({ prompt: 'a cat', n: 1, size: '1536x1024', model: 'gpt-image-2', quality: 'auto' })
    expect(fetchImage).toHaveBeenCalledWith('https://oai/img.png', { saveAsset: { name: 'a cat', extension: 'jpg', mode: 'auto' } })
    expect(app.state.meta).toEqual({
      source: 'openai',
      prompt: 'a cat',
      generatedPrompt: 'a fluffy cat',
      model: 'gpt-image-2',
      size: '1536x1024',
      revisedPrompt: 'a fluffy cat',
    })
  })

  it('picks the size for the orientation of the frame, the cell, or the model', () => {
    const http = mock.httpRequest(() => generation({ url: 'https://oai/img.png' }))
    mock.fetchImage(() => mock.image())
    get(makeApp({ settings, config: base, frame: { width: 480, height: 800 } }), makeContext())
    expect(requestBody(http, 0).size).toBe('1024x1536')
    get(makeApp({ settings, config: base, frame: { width: 800, height: 480, rotate: 90 } }), makeContext())
    expect(requestBody(http, 1).size).toBe('1024x1536')
    get(makeApp({ settings, config: base }), makeContext({ imageWidth: 100, imageHeight: 400 }))
    expect(requestBody(http, 2).size).toBe('1024x1536')
    get(makeApp({ settings, config: { ...base, model: 'dall-e-3' } }), makeContext())
    expect(requestBody(http, 3).size).toBe('1792x1024')
    get(makeApp({ settings, config: { ...base, model: 'dall-e-2', size: '512x512' } }), makeContext())
    expect(requestBody(http, 4).size).toBe('512x512')
    get(makeApp({ settings, config: { ...base, size: '999x999' } }), makeContext())
    expect(requestBody(http, 5).size).toBe('1024x1024')
    // No canvas, no orientation: the model's default size.
    get(makeApp({ settings, config: base }), makeContext({ hasImage: false }))
    expect(requestBody(http, 6).size).toBe('1024x1024')
  })

  it('asks an ESP32 for a small jpeg and decodes base64 data', () => {
    const http = mock.httpRequest(() => generation({ b64_json: 'AAAA' }))
    const fetchImage = mock.fetchImage(() => mock.image())
    get(makeApp({ settings, config: { ...base, outputFormat: 'auto', outputCompression: 0 }, frame: { embedded: true } }), makeContext())
    expect(requestBody(http)).toMatchObject({ size: '1024x640', quality: 'low', output_format: 'jpeg', output_compression: 50 })
    expect(fetchImage.calls[0][0]).toBe('data:image/jpeg;base64,AAAA')
  })

  it('sends dall-e-3 its style and quality', () => {
    const http = mock.httpRequest(() => generation({ url: 'https://oai/img.png' }))
    mock.fetchImage(() => mock.image())
    get(makeApp({ settings, config: { ...base, model: 'dall-e-3', style: 'vivid', quality: 'hd' } }), makeContext())
    expect(requestBody(http)).toMatchObject({ style: 'vivid', quality: 'hd' })
  })

  it('names what went wrong', () => {
    expect(() => get(makeApp({ settings, config: { ...base, prompt: '' } }), makeContext())).toThrow('No prompt provided')
    expect(() => get(makeApp({ settings: {}, config: base }), makeContext())).toThrow('OpenAI API key')
    mock.httpRequest(() => mock.response(400, { error: { message: 'bad size' } }))
    expect(() => get(makeApp({ settings, config: base }), makeContext())).toThrow('Error making request 400: bad size')
    mock.httpRequest(() => mock.json({ data: [{}] }))
    expect(() => get(makeApp({ settings, config: base }), makeContext())).toThrow('No image data returned from OpenAI.')
    mock.httpRequest(() => generation({ url: 'https://oai/img.png' }))
    mock.fetchImage(() => ({ image: null, error: 'too big' }))
    expect(() => get(makeApp({ settings, config: base }), makeContext())).toThrow('Error fetching image from OpenAI: too big')
  })
})
