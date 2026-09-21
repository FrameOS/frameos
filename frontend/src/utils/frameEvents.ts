import _events from '../../schema/events.json'
import type { AppConfigField, FrameEvent, FrameScene } from '../types'
import { customEventDeclarableOrigins, type EventOrigin } from './eventsContract.gen'

export const builtinFrameEvents = _events as FrameEvent[]
export const builtinFrameEventNames = new Set(builtinFrameEvents.map((event) => event.name))

export function normalizeCustomEventField(field: Partial<AppConfigField>): AppConfigField {
  return {
    name: String(field.name ?? '').trim(),
    label: String(field.label ?? ''),
    type: field.type ?? 'string',
    ...(field.options ? { options: field.options } : {}),
    ...(field.required !== undefined ? { required: field.required } : {}),
    ...(field.secret !== undefined ? { secret: field.secret } : {}),
    ...(field.value !== undefined ? { value: field.value } : {}),
    ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
    ...(field.hint !== undefined ? { hint: field.hint } : {}),
    ...(field.rows !== undefined ? { rows: field.rows } : {}),
    ...(field.seq !== undefined ? { seq: field.seq } : {}),
    ...(field.showIf !== undefined ? { showIf: field.showIf } : {}),
  }
}

/**
 * The `origins` a custom event may declare, as the device reads them
 * (`declaredCustomEventOrigins` in events.nim): only the contract's declarable
 * origins count, so anything else is dropped rather than stored. Sorted, so
 * the order the boxes were ticked in never shows up as a scene change.
 */
export function normalizeCustomEventOrigins(origins: unknown): EventOrigin[] {
  const declared = Array.isArray(origins) ? origins : []
  return customEventDeclarableOrigins.filter((origin) => declared.includes(origin)).sort()
}

/**
 * `event` with `origin` declared or not. No `origins` key at all once none is
 * left, so a scene that never opted in is not rewritten.
 */
export function withCustomEventOrigin(event: FrameEvent, origin: EventOrigin, enabled: boolean): FrameEvent {
  const { origins: current, ...rest } = event
  const origins = normalizeCustomEventOrigins(
    enabled ? [...(current ?? []), origin] : (current ?? []).filter((candidate) => candidate !== origin)
  )
  return origins.length > 0 ? { ...rest, origins } : rest
}

export function normalizeCustomEvent(event: Partial<FrameEvent>): FrameEvent {
  const origins = normalizeCustomEventOrigins(event.origins)
  return {
    name: String(event.name ?? '').trim(),
    description: String(event.description ?? ''),
    fields: (event.fields ?? []).map((field) => normalizeCustomEventField(field)),
    canDispatch: true,
    canListen: true,
    ...(origins.length > 0 ? { origins } : {}),
  }
}

export function customFrameEventsForScene(scene?: Pick<FrameScene, 'customEvents'> | null): FrameEvent[] {
  const seen = new Set<string>()
  return (scene?.customEvents ?? [])
    .map((event) => normalizeCustomEvent(event))
    .filter((event) => {
      if (!event.name || seen.has(event.name) || builtinFrameEventNames.has(event.name)) {
        return false
      }
      seen.add(event.name)
      return true
    })
}

export function frameEventsForScene(scene?: Pick<FrameScene, 'customEvents'> | null): FrameEvent[] {
  return [...builtinFrameEvents, ...customFrameEventsForScene(scene)]
}

export function frameEventForScene(
  name: string | null | undefined,
  scene?: Pick<FrameScene, 'customEvents'> | null
): FrameEvent | null {
  if (!name) {
    return null
  }
  return frameEventsForScene(scene).find((event) => event.name === name) ?? null
}
