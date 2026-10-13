// The state of one Home Assistant entity, as Home Assistant's REST API
// returns it (GET /api/states/<entity_id>). JSON over frameos.httpRequest.

const REQUEST_TIMEOUT_MS = 10000
const MINIMUM_FETCH_INTERVAL_MS = 1000

// The last good reply, reused for a second so a render that reads this node
// more than once asks Home Assistant once. Module state lives as long as the
// node's interpreter: a Pi keeps it between renders, an ESP32 rebuilds the
// interpreter after every render. Kept as text, which costs about its size;
// a parsed object costs many times that.
export const lastReply = { at: 0, body: '' }

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function errorReply(message: string): { error: string } {
  frameos.error(message)
  return { error: message }
}

// Home Assistant entity ids are `<domain>.<object_id>`, both halves
// `[a-z0-9_]+`. Anything else (a `/`, a `?`, a `..`) would be spliced into the
// request path and could steer the frame's HA token at a different endpoint,
// so the shape is enforced before the URL is built.
export function isHaEntityId(value: string): boolean {
  return /^[a-z0-9_]+\.[a-z0-9_]+$/.test(value)
}

export function haStateUrl(haUrl: string, entityId: string): string {
  const base = haUrl.endsWith('/') ? haUrl.slice(0, -1) : haUrl
  return `${base}/api/states/${encodeURIComponent(entityId)}`
}

export function get(app: FrameOSApp, context: FrameOSContext): unknown {
  const haUrl = text(frameos.getSetting('homeAssistant', 'url'))
  if (!haUrl) return errorReply('Please provide a Home Assistant URL in the settings.')
  const accessToken = text(frameos.getSetting('homeAssistant', 'accessToken'))
  if (!accessToken) return errorReply('Please provide a Home Assistant access token in the settings.')

  if (lastReply.body && lastReply.at + MINIMUM_FETCH_INTERVAL_MS > Date.now()) return JSON.parse(lastReply.body)

  const entityId = String(app.config.entityId ?? '').trim()
  if (!isHaEntityId(entityId)) {
    return errorReply(
      `Invalid Home Assistant entity id "${entityId}": expected <domain>.<object_id> using only a-z, 0-9 and _.`
    )
  }
  const debug = app.config.debug === true || String(app.config.debug) === 'true'
  const url = haStateUrl(haUrl, entityId)
  if (debug) frameos.log(`Fetching Home Assistant status from ${url}`)

  const response = frameos.httpRequest(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Accept-Encoding': 'identity' },
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  if (response.status === 0) {
    return errorReply(`Error fetching Home Assistant status: ${response.error ?? 'request failed'}`)
  }
  const body = response.body ?? ''
  if (response.status >= 400) {
    return errorReply(`Error fetching Home Assistant status: HTTP ${response.status}: ${body}`)
  }
  let state: unknown
  try {
    state = JSON.parse(body)
  } catch (error) {
    return errorReply(`Error fetching Home Assistant status: ${errorMessage(error)}`)
  }
  lastReply.at = Date.now()
  lastReply.body = body
  if (debug) frameos.log(JSON.stringify(state))
  return state
}
