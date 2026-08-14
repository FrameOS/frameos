import { apiFetch } from './apiFetch'

// Streaming client for the cloud's AI chat v2 endpoint (POST /api/ai/chat,
// NDJSON — one event per line). Used by chatLogic in cloud mode only; the
// self-hosted backend keeps its own /api/ai/scenes/chat protocol.

export type CloudAiChatEvent =
  | { type: 'chat'; chatId: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; label: string; status: 'start' | 'done' | 'error'; detail?: string }
  | { type: 'scenes'; tool: 'build_scene' | 'modify_scene'; title?: string; scenes: Record<string, any>[] }
  | { type: 'done'; tool: string; reply: string }
  | { type: 'error'; detail: string }

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

export async function streamCloudAiChat(
  request: CloudAiChatRequest,
  onEvent: (event: CloudAiChatEvent) => void | Promise<void>
): Promise<void> {
  const response = await apiFetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload?.detail || 'Failed to send chat message')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
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
    if (event && typeof event === 'object' && typeof (event as any).type === 'string') {
      await onEvent(event)
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      await handleLine(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
    }
  }
  await handleLine(buffer)
}
