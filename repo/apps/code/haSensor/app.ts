// The state of one Home Assistant entity (GET /api/states/<entity_id>).
export const lastReply = { at: 0, body: '' }

function errorReply(error) {
  frameos.error(error)
  return { error }
}

export function get(app) {
  const url = frameos.getSetting('homeAssistant', 'url')
  if (!url) return errorReply('Please provide a Home Assistant URL in the settings.')
  const token = frameos.getSetting('homeAssistant', 'accessToken')
  if (!token) return errorReply('Please provide a Home Assistant access token in the settings.')
  if (lastReply.body && lastReply.at + 1000 > Date.now()) return JSON.parse(lastReply.body)

  const id = (app.config.entityId ?? '').trim()
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(id))
    return errorReply(
      `Invalid Home Assistant entity id "${id}": expected <domain>.<object_id> using only a-z, 0-9 and _.`
    )
  const stateUrl = `${url.endsWith('/') ? url.slice(0, -1) : url}/api/states/${id}`
  if (app.config.debug) frameos.log(`Fetching Home Assistant status from ${stateUrl}`)
  const { status, body, error } = frameos.httpRequest(stateUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Encoding': 'identity' },
    timeoutMs: 10000,
  })
  const fail = (why) => errorReply(`Error fetching Home Assistant status: ${why}`)
  if (!status) return fail(error)
  if (status >= 400) return fail(`HTTP ${status}: ${body}`)
  let state
  try {
    state = JSON.parse(body)
  } catch (e) {
    return fail(e.message)
  }
  lastReply.at = Date.now()
  lastReply.body = body
  if (app.config.debug) frameos.log(JSON.stringify(state))
  return state
}
