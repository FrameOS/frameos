import { get } from './app'

const settings = { openAI: { apiKey: 'sk-test' } }
const chat = (content: string) => mock.json({ choices: [{ message: { role: 'assistant', content } }] })

describe('openaiText', () => {
  it('posts the prompts to the chat completions API and returns the reply', () => {
    const http = mock.httpRequest(() => chat('Hello!'))
    const app = makeApp({ settings, config: { system: 'Be brief.', user: 'Say hi', model: 'gpt-5.5' } })
    expect(get(app)).toBe('Hello!')
    expect(http).toHaveBeenCalledTimes(1)
    const [url, options] = http.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(options).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer sk-test' }, timeoutMs: 60000 })
    expect(JSON.parse(options.body)).toEqual({
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Say hi' },
      ],
    })
  })

  it('logs the prompt and reply sizes in bytes', () => {
    mock.httpRequest(() => chat('héllo'))
    const log = mock.log()
    get(makeApp({ settings, config: { system: 'é', user: 'ab', model: 'm' } }))
    expect(log.calls[0][0]).toEqual({ model: 'm', systemPromptChars: 2, userPromptChars: 2 })
    expect(log.calls[1][0]).toEqual({ replyChars: 6 })
  })

  it('gives an empty reply, with the error logged, when a prompt or the key is missing', () => {
    const http = mock.httpRequest(() => mock.response(200, {}))
    const error = mock.error()
    expect(get(makeApp({ settings, config: { system: '', user: '', model: 'm' } }))).toBe('')
    expect(get(makeApp({ settings: {}, config: { system: 's', user: 'u', model: 'm' } }))).toBe('')
    expect(http).not.toHaveBeenCalled()
    expect(error).toHaveBeenLastCalledWith('Please provide an OpenAI API key in the settings.')
  })

  it('throws when the request fails, so the cache can serve the last reply', () => {
    mock.httpRequest(() => mock.response(401, { error: { message: 'bad key' } }))
    expect(() => get(makeApp({ settings, config: { system: 's', user: 'u', model: 'm' } }))).toThrow(
      'Error making request 401: bad key'
    )
    mock.httpRequest(() => ({ status: 0, error: 'no route' }))
    expect(() => get(makeApp({ settings, config: { system: 's', user: 'u', model: 'm' } }))).toThrow(
      'OpenAI API error: no route'
    )
  })
})
