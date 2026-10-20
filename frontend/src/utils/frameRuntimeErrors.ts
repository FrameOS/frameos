import type { FrameScene, LogType } from '../types'
import { publicSceneId, sceneIdsRefer } from './systemScenes'

export interface RuntimeNodeError {
  event: string
  logId: number
  message: string
  nodeId: string
  runtimeNodeId?: number
  sceneId: string
  timestamp: string
}

interface RuntimeLogPayload {
  event?: string
  error?: unknown
  message?: unknown
  nodeId?: unknown
  sceneId?: unknown
  sourceNodeId?: unknown
  stack?: unknown
}

const RECENT_RUNTIME_ERROR_LOG_LIMIT = 2000

function valueAsId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return null
}

function valueAsRuntimeNodeId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value)
  }
  return null
}

function runtimeErrorMessage(payload: RuntimeLogPayload): string {
  for (const value of [payload.message, payload.error, payload.stack]) {
    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }
  return String(payload.event ?? 'Runtime error')
}

function isRuntimeNodeErrorEvent(event: unknown): event is string {
  if (typeof event !== 'string') {
    return false
  }
  if (event === 'runEventInterpreted:error' || event === 'jsApp:error') {
    return true
  }
  return event.startsWith('interpreter:') && event.toLowerCase().includes('error')
}

export function parseRuntimeNodeErrorLog(log: LogType): RuntimeLogPayload | null {
  if (log.type !== 'webhook') {
    return null
  }
  try {
    const payload = JSON.parse(log.line) as RuntimeLogPayload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null
    }
    if (!isRuntimeNodeErrorEvent(payload.event) || !valueAsId(payload.sceneId)) {
      return null
    }
    if (
      !valueAsId(payload.sourceNodeId) &&
      valueAsRuntimeNodeId(payload.nodeId) === null &&
      !valueAsId(payload.nodeId)
    ) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

interface RuntimeNodeMapBuilder {
  maps: Record<string, Record<number, string>>
  runtimeNodeIdFor: (sourceId: unknown) => number | null
}

function createRuntimeNodeMapBuilder(): RuntimeNodeMapBuilder {
  const runtimeNodeIdBySourceId = new Map<string, number>()
  const runtimeNodeIdFor = (sourceId: unknown): number | null => {
    const key = valueAsId(sourceId)
    if (!key) {
      return null
    }
    const existing = runtimeNodeIdBySourceId.get(key)
    if (existing !== undefined) {
      return existing
    }
    const next = runtimeNodeIdBySourceId.size + 1
    runtimeNodeIdBySourceId.set(key, next)
    return next
  }

  return { maps: {}, runtimeNodeIdFor }
}

function appendRuntimeNodeMaps(builder: RuntimeNodeMapBuilder, scenes: FrameScene[]): void {
  for (const scene of scenes) {
    const nodeMap: Record<number, string> = {}
    builder.maps[scene.id] = nodeMap
    for (const node of scene.nodes ?? []) {
      const runtimeNodeId = builder.runtimeNodeIdFor(node.id)
      if (runtimeNodeId !== null) {
        nodeMap[runtimeNodeId] = node.id
      }
    }
    for (const edge of scene.edges ?? []) {
      builder.runtimeNodeIdFor(edge.id)
      builder.runtimeNodeIdFor(edge.source)
      builder.runtimeNodeIdFor(edge.target)
    }
  }
}

// Keyed by the scene's own id: a scene the frame was handed (Preview on
// frame) numbers its nodes the same way, and an older runtime's legacy
// `uploaded/<id>` is looked up through publicSceneId.
function buildRuntimeNodeMaps(scenes: FrameScene[]): Record<string, Record<number, string>> {
  const builder = createRuntimeNodeMapBuilder()
  appendRuntimeNodeMaps(builder, scenes)
  return builder.maps
}

export function runtimeNodeErrorsByNodeId(
  logs: LogType[],
  scenes: FrameScene[],
  sceneId: string
): Record<string, RuntimeNodeError> {
  const scene = scenes.find((candidate) => candidate.id === sceneId)
  if (!scene) {
    return {}
  }

  const nodeIds = new Set((scene.nodes ?? []).map((node) => node.id))
  const runtimeNodeMaps = buildRuntimeNodeMaps(scenes)
  const errors: Record<string, RuntimeNodeError> = {}
  const start = Math.max(0, logs.length - RECENT_RUNTIME_ERROR_LOG_LIMIT)

  for (let index = logs.length - 1; index >= start; index--) {
    const log = logs[index]
    if (!log) {
      continue
    }
    const payload = parseRuntimeNodeErrorLog(log)
    const runtimeSceneId = valueAsId(payload?.sceneId)
    if (!payload || !runtimeSceneId || !sceneIdsRefer(runtimeSceneId, sceneId)) {
      continue
    }

    const runtimeNodeId = valueAsRuntimeNodeId(payload.nodeId)
    const explicitNodeId = valueAsId(payload.sourceNodeId)
    const fallbackNodeId =
      runtimeNodeId !== null
        ? runtimeNodeMaps[publicSceneId(runtimeSceneId)]?.[runtimeNodeId] ?? valueAsId(payload.nodeId)
        : valueAsId(payload.nodeId)
    const nodeId = explicitNodeId && nodeIds.has(explicitNodeId) ? explicitNodeId : fallbackNodeId
    if (!nodeId || !nodeIds.has(nodeId) || errors[nodeId]) {
      continue
    }

    errors[nodeId] = {
      event: String(payload.event),
      logId: log.id,
      message: runtimeErrorMessage(payload),
      nodeId,
      ...(runtimeNodeId !== null ? { runtimeNodeId } : {}),
      sceneId: runtimeSceneId,
      timestamp: log.timestamp,
    }
  }

  return errors
}
