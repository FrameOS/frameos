import { apiFetch } from './apiFetch'

// Streaming client for the cloud's AI chat v2 endpoint (POST /api/ai/chat,
// NDJSON — one event per line). Used by chatLogic in cloud mode only; the
// self-hosted backend keeps its own /api/ai/scenes/chat protocol.
//
// Turns run detached on the cloud: if this stream drops mid-turn (a proxy
// idle cut, a flaky link) the turn keeps going and we reopen the stream at
// GET /api/ai/chat/turns/<turnId>?after=<events seen>. Mirrors the store
// panel's client (cloud/apps/auth-web/src/lib/ai-chat-client.ts).

export type CloudAiChatEvent =
  | { type: 'chat'; chatId: string; turnId?: string }
  | { type: 'delta'; text: string }
  | {
      type: 'tool'
      name: string
      label: string
      // progress = the model is still writing the call (detail = bytes so far)
      status: 'progress' | 'start' | 'done' | 'error'
      detail?: string
    }
  | { type: 'scenes'; tool: 'build_scene' | 'modify_scene'; title?: string; scenes: Record<string, any>[] }
  | { type: 'done'; tool: string; reply: string }
  | { type: 'error'; detail: string }
  | { type: 'ping' }

export interface CloudAiChatRequest {
  prompt: string
  chatId: string
  frameId: string | number
  sceneId?: string | null
  scene?: Record<string, any> | null
  selectedNodes?: Record<string, any>[]
  selectedEdges?: Record<string, any>[]
  history: { role: string; content: string }[]
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

// What the user reads instead of the browser's bare "network error".
export function transportFailureMessage(elapsedMs: number, hadTurn: boolean): string {
  const base = `Connection to the assistant dropped after ${formatElapsed(elapsedMs)}`
  if (!hadTurn) {
    return `${base}, before it started working. Check your connection and try again.`
  }
  return `${base} and could not be re-established. The assistant may still finish on its own — reopen this chat in a minute to see its reply.`
}

export class CloudAiChatTransportError extends Error {
  readonly elapsedMs: number
  readonly turnId: string | undefined
  constructor(elapsedMs: number, turnId?: string) {
    super(transportFailureMessage(elapsedMs, Boolean(turnId)))
    this.name = 'CloudAiChatTransportError'
    this.elapsedMs = elapsedMs
    this.turnId = turnId
  }
}

const RESUME_ATTEMPTS = 5
const RESUME_DELAYS_MS = [500, 1500, 3000, 5000, 8000]

async function readNdjson(body: ReadableStream<Uint8Array>, onLine: (line: string) => Promise<void>): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      await onLine(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
    }
  }
  buffer += decoder.decode()
  await onLine(buffer)
}

export async function streamCloudAiChat(
  request: CloudAiChatRequest,
  onEvent: (event: CloudAiChatEvent) => void | Promise<void>,
  options: { onResume?: (info: { attempt: number; elapsedMs: number }) => void } = {}
): Promise<void> {
  const startedAt = Date.now()
  let turnId: string | undefined
  let received = 0
  let finished = false

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }
    let event: CloudAiChatEvent | null = null
    try {
      event = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!event || typeof event !== 'object' || typeof (event as any).type !== 'string') {
      return
    }
    if (event.type === 'ping') {
      return
    }
    if (event.type === 'chat' && event.turnId) {
      turnId = event.turnId
    }
    if (event.type === 'done' || event.type === 'error') {
      finished = true
    }
    received += 1
    await onEvent(event)
  }

  const response = await apiFetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload?.detail || 'Failed to send chat message')
  }
  try {
    await readNdjson(response.body, handleLine)
  } catch {
    // dropped mid-stream; resume below
  }
  if (finished) {
    return
  }
  if (!turnId) {
    throw new CloudAiChatTransportError(Date.now() - startedAt)
  }
  for (let attempt = 1; attempt <= RESUME_ATTEMPTS; attempt += 1) {
    options.onResume?.({ attempt, elapsedMs: Date.now() - startedAt })
    await new Promise((resolve) =>
      setTimeout(resolve, RESUME_DELAYS_MS[Math.min(attempt, RESUME_DELAYS_MS.length) - 1])
    )
    let resumed: Response
    try {
      resumed = await apiFetch(`/api/ai/chat/turns/${encodeURIComponent(turnId)}?after=${received}`)
    } catch {
      continue
    }
    if (resumed.status === 404) {
      break
    }
    if (!resumed.ok || !resumed.body) {
      continue
    }
    try {
      await readNdjson(resumed.body, handleLine)
    } catch {
      // try again
    }
    if (finished) {
      return
    }
  }
  throw new CloudAiChatTransportError(Date.now() - startedAt, turnId)
}
