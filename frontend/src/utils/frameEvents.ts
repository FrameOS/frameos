import _events from '../../schema/events.json'
import type { AppConfigField, FrameEvent, FrameScene } from '../types'

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

export function normalizeCustomEvent(event: Partial<FrameEvent>): FrameEvent {
  return {
    name: String(event.name ?? '').trim(),
    description: String(event.description ?? ''),
    fields: (event.fields ?? []).map((field) => normalizeCustomEventField(field)),
    canDispatch: true,
    canListen: true,
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
