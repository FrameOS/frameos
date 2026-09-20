// The scene event contract as the SPA reads it. docs/events-contract.json is
// the source, eventsContract.gen.ts its tables; this file is the handful of
// questions the editor, the preview and the schedule panel ask of them.
// Deliberately import-free beyond the tables, so the model files and the
// import-free helpers (scheduleEvents.ts) can use it. docs/events.md is the
// prose.

import {
  contractEventSpecs,
  sceneChangedLogEvents,
  sceneStateChangedLogEvents,
  type ContractEventName,
  type ContractEventSpec,
} from './eventsContract.gen'

const specs: Record<string, ContractEventSpec | undefined> = contractEventSpecs

/** The contract row of a built-in event; undefined for a scene's custom event. */
export function contractEventSpec(name: string | null | undefined): ContractEventSpec | undefined {
  return name && Object.prototype.hasOwnProperty.call(specs, name) ? specs[name] : undefined
}

export function isContractEvent(name: string | null | undefined): name is ContractEventName {
  return contractEventSpec(name) !== undefined
}

/** Lifecycle events and scene commands: the host sends these; they are not
 * something a person presses, so the preview offers no button for them. */
export function isHostEvent(name: string | null | undefined): boolean {
  const eventClass = contractEventSpec(name)?.class
  return eventClass === 'lifecycle' || eventClass === 'scene-command'
}

/** Pointer input: sent by the canvas itself, with a position. */
export function isPointerEvent(name: string | null | undefined): boolean {
  return contractEventSpec(name)?.device === 'pointer'
}

/** An event whose payload IS the scene's state fields (`setSceneState`): its
 * dispatch node is configured with the scene's fields, not the event's. */
export function eventPayloadIsSceneState(name: string | null | undefined): boolean {
  return contractEventSpec(name)?.sceneState === 'payload'
}

/** An event node that offers the scene's state fields rather than payload
 * fields of its own (`init`, `render`, `setSceneState`). */
export function eventOffersSceneState(name: string | null | undefined): boolean {
  return contractEventSpec(name)?.sceneState !== undefined
}

/** Events the Schedule panel offers, in contract order. */
export function schedulableContractEvents(): { name: ContractEventName; spec: ContractEventSpec }[] {
  return (Object.keys(contractEventSpecs) as ContractEventName[])
    .filter((name) => contractEventSpecs[name].schedule !== undefined)
    .map((name) => ({ name, spec: contractEventSpecs[name] }))
}

/** A frame log line that says "the frame now shows `sceneId`". */
export function logEventIsSceneChange(event: unknown): boolean {
  return typeof event === 'string' && sceneChangedLogEvents.includes(event)
}

/** A frame log line after which the frame's scene state is worth re-reading. */
export function logEventIsSceneStateChange(event: unknown): boolean {
  return typeof event === 'string' && sceneStateChangedLogEvents.includes(event)
}
