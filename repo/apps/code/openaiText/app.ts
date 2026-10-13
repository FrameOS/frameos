// OpenAI text app: one chat completion over frameos.httpRequest, the reply as
// the app's string output.

const API_URL = 'https://api.openai.com/v1/chat/completions'
const TIMEOUT = 60000
const DEFAULT_SYSTEM = "You're a smart e-ink frame running FrameOS. Reply with plain text only. Space is very limited."

type Response = { status: number; body?: string; error?: string }

// A string field keeps its default unless the config holds a string, the way
// the Nim app read its config.
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Sizes are logged in UTF-8 bytes, as the Nim app counted them.
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

// What a request logs. Prompts can carry personal data and logs ship to the
// control plane, so only their sizes are recorded.
export function requestLogPayload(model: string, system: string, user: string): Record<string, unknown> {
  return { model, systemPromptChars: utf8Length(system), userPromptChars: utf8Length(user) }
}

export function requestBody(model: string, system: string, user: string): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
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

// The first choice's message, "" when there is none. Throws on a body that is
// not JSON.
export function replyContent(body: string): string {
  const json: unknown = JSON.parse(body)
  const choices = isObject(json) ? json.choices : undefined
  const first = Array.isArray(choices) && isObject(choices[0]) ? choices[0] : {}
  const message = isObject(first.message) ? first.message : {}
  return str(message.content, '')
}

export function get(app: FrameOSApp, context: FrameOSContext): string {
  const c = app.config
  const system = str(c.system, DEFAULT_SYSTEM)
  const user = str(c.user, '')
  const model = str(c.model, 'gpt-5.5')
  // Errors are logged only; the output is then "".
  if (user === '' && system === '') {
    frameos.error('No system or user prompt provided in app config.')
    return ''
  }
  const apiKey = str(frameos.getSetting('openAI', 'apiKey'), '')
  if (apiKey === '') {
    frameos.error('Please provide an OpenAI API key in the settings.')
    return ''
  }

  frameos.log(requestLogPayload(model, system, user))
  const response: Response = frameos.httpRequest(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody(model, system, user)),
    timeoutMs: TIMEOUT,
  })
  // A request that never got an answer, or a reply that is not JSON, is the
  // one error that also becomes the output.
  const failure = (message: string): string => {
    frameos.error(`OpenAI API error: ${message}`)
    return `OpenAI API error: ${message}`
  }
  if (response.status === 0) return failure(response.error ?? 'request failed')
  if (response.status !== 200) {
    frameos.error(`Error making request ${response.status}: ${apiErrorDetail(response.body ?? '')}`)
    return ''
  }
  let reply: string
  try {
    reply = replyContent(response.body ?? '')
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error))
  }
  frameos.log({ replyChars: utf8Length(reply) })
  return reply
}
