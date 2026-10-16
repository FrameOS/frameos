// OpenAI text: one chat completion over frameos.httpRequest. A missing prompt or
// key is logged and gives "". A request that fails throws: the node fails, its
// cache keeps nothing, and a cache with staleEnabled serves the last reply.
const bytes = (text) => {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}
const fail = (message) => (frameos.error(message), '')

export function get(app) {
  const { system, user, model } = app.config
  if (!system && !user) return fail('No system or user prompt provided in app config.')
  const apiKey = frameos.getSetting('openAI', 'apiKey')
  if (!apiKey) return fail('Please provide an OpenAI API key in the settings.')

  frameos.log({ model, systemPromptChars: bytes(system), userPromptChars: bytes(user) })
  const r = frameos.httpRequest('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    timeoutMs: 60000,
  })
  if (r.status && r.status !== 200) {
    let detail = r.body
    try {
      const json = JSON.parse(r.body)
      const e = json?.error
      detail = typeof e?.message === 'string' ? e.message : typeof e === 'string' ? e : JSON.stringify(json)
    } catch {}
    throw new Error(`Error making request ${r.status}: ${detail}`)
  }
  if (!r.status) throw new Error(`OpenAI API error: ${r.error}`)
  let reply
  try {
    reply = JSON.parse(r.body)?.choices?.[0]?.message?.content ?? ''
  } catch (e) {
    throw new Error(`OpenAI API error: ${e.message}`)
  }
  frameos.log({ replyChars: bytes(reply) })
  return reply
}
