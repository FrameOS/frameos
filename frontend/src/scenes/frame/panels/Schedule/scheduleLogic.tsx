import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { v4 as uuidv4 } from 'uuid'

import type { scheduleLogicType } from './scheduleLogicType'
import { ScheduledEvent, StateField } from '../../../../types'
import { frameLogic } from '../../frameLogic'

export interface ScheduleLogicProps {
  frameId: number
}

export const scheduleLogic = kea<scheduleLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Schedule', 'scheduleLogic']),
  props({} as ScheduleLogicProps),
  key((props) => props.frameId),

  connect(({ frameId }: ScheduleLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm']],
    actions: [frameLogic({ frameId }), ['setFrameFormValues']],
  })),

  actions({
    setSceneSearch: (sceneSearch: string) => ({ sceneSearch }),
    addEventForScene: (sceneId: string, insertIndex?: number | null) => ({
      event: newScheduledEvent(sceneId),
      insertIndex,
    }),
    editEvent: (id: string) => ({ id }),
    closeEvent: (id: string) => ({ id }),
    deleteEvent: (id: string) => ({ id }),
    showDropZone: true,
    hideDropZone: true,
    setDropIndex: (dropIndex: number | null) => ({ dropIndex }),
  }),

  reducers({
    dropIndex: [
      null as number | null,
      {
        setDropIndex: (_, { dropIndex }) => dropIndex,
        hideDropZone: () => null,
        addEventForScene: () => null,
      },
    ],
    dropZoneVisible: [
      false,
      {
        showDropZone: () => true,
        hideDropZone: () => false,
        addEventForScene: () => false,
      },
    ],
    sceneSearch: [
      '',
      {
        setSceneSearch: (_, { sceneSearch }) => sceneSearch,
      },
    ],
    editingEvents: [
      {} as Record<string, boolean>,
      {
        addEventForScene: (state, { event }) => ({ ...state, [event.id]: true }),
        editEvent: (state, { id }) => ({ ...state, [id]: true }),
        closeEvent: (state, { id }) => {
          const { [id]: _, ...rest } = state
          return rest
        },
        deleteEvent: (state, { id }) => {
          const { [id]: _, ...rest } = state
          return rest
        },
      },
    ],
  }),

  selectors({
    schedule: [(s) => [s.frameForm, s.frame], (frameForm, frame) => frameForm.schedule ?? frame.schedule],
    events: [(s) => [s.schedule], (schedule) => schedule?.events ?? []],
    disabled: [(s) => [s.schedule], (schedule) => schedule?.disabled ?? false],
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes],
    sortedScenes: [
      (s) => [s.scenes],
      (scenes) => [...(scenes ?? [])].toSorted((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    ],
    filteredScenes: [
      (s) => [s.sortedScenes, s.sceneSearch],
      (sortedScenes, sceneSearch) => {
        const normalizedSearch = sceneSearch.trim().toLowerCase()
        if (!normalizedSearch) {
          return sortedScenes
        }
        return sortedScenes.filter((scene) =>
          [scene.name, scene.id, ...(scene.nodes ?? []).map((node) => `${node.type} ${node.id}`)]
            .join(' ')
            .toLowerCase()
            .includes(normalizedSearch)
        )
      },
    ],
    fieldsForScene: [
      (s) => [s.frame, s.frameForm],
      (frame, frameForm): Record<string, StateField[]> =>
        (frameForm?.scenes ?? frame.scenes ?? []).reduce((acc, scene) => {
          acc[scene.id] = scene.fields ?? []
          return acc
        }, {} as Record<string, StateField[]>),
    ],
    eventCountsByScene: [
      (s) => [s.events],
      (events): Record<string, number> =>
        events.reduce((acc, event) => {
          if (event.payload.sceneId) {
            acc[event.payload.sceneId] = (acc[event.payload.sceneId] ?? 0) + 1
          }
          return acc
        }, {} as Record<string, number>),
    ],
    sortedEvents: [
      (s) => [s.events],
      (events) => [...events].sort((a, b) => (a.hour === b.hour ? a.minute - b.minute : a.hour - b.hour)),
    ],
  }),

  listeners(({ actions, values }) => ({
    addEventForScene: ({ event, insertIndex }) => {
      const nextEvent = configureEventForInsert(event, values.sortedEvents, insertIndex)
      actions.setFrameFormValues({
        ...values.frameForm,
        schedule: {
          ...values.schedule,
          events: insertEvent(values.events, values.sortedEvents, nextEvent, insertIndex),
        },
      })
    },
    deleteEvent: ({ id }) => {
      actions.setFrameFormValues({
        ...values.frameForm,
        schedule: { ...values.schedule, events: values.events.filter((event) => event.id !== id) },
      })
    },
  })),
])

function eventMinute(event: Pick<ScheduledEvent, 'hour' | 'minute'>): number {
  return Math.max(0, Math.min(1439, event.hour * 60 + event.minute))
}

function minuteConfig(totalMinutes: number): Pick<ScheduledEvent, 'hour' | 'minute'> {
  const boundedMinutes = Math.max(0, Math.min(1439, Math.round(totalMinutes)))
  return {
    hour: Math.floor(boundedMinutes / 60),
    minute: boundedMinutes % 60,
  }
}

function insertedWeekday(before: ScheduledEvent | undefined, after: ScheduledEvent | undefined): number {
  if (before && after && before.weekday === after.weekday) {
    return before.weekday
  }
  return before?.weekday ?? after?.weekday ?? 0
}

function insertedMinute(before: ScheduledEvent | undefined, after: ScheduledEvent | undefined): number {
  if (before && after) {
    const beforeMinute = eventMinute(before)
    const afterMinute = eventMinute(after)
    if (afterMinute > beforeMinute + 1) {
      return Math.floor((beforeMinute + afterMinute) / 2)
    }
    return beforeMinute
  }
  if (before) {
    return Math.min(1439, eventMinute(before) + 30)
  }
  if (after) {
    return Math.max(0, eventMinute(after) - 30)
  }
  return 23 * 60 + 59
}

function configureEventForInsert(
  event: ScheduledEvent,
  sortedEvents: ScheduledEvent[],
  insertIndex?: number | null
): ScheduledEvent {
  if (insertIndex === undefined || insertIndex === null) {
    return event
  }

  const before = sortedEvents[insertIndex - 1]
  const after = sortedEvents[insertIndex]
  const time = minuteConfig(insertedMinute(before, after))

  return {
    ...event,
    ...time,
    weekday: insertedWeekday(before, after),
  }
}

function insertEvent(
  events: ScheduledEvent[],
  sortedEvents: ScheduledEvent[],
  event: ScheduledEvent,
  insertIndex?: number | null
): ScheduledEvent[] {
  if (insertIndex === undefined || insertIndex === null) {
    return [...events, event]
  }

  const before = sortedEvents[insertIndex - 1]
  const after = sortedEvents[insertIndex]
  const eventTime = eventMinute(event)
  const beforeTime = before ? eventMinute(before) : null
  const nextEvents = [...events]
  const targetId = before && beforeTime !== null && eventTime <= beforeTime ? before.id : after?.id
  const targetIndex = targetId ? nextEvents.findIndex((candidate) => candidate.id === targetId) : -1

  if (targetIndex === -1) {
    nextEvents.push(event)
  } else if (before && targetId === before.id) {
    nextEvents.splice(targetIndex + 1, 0, event)
  } else {
    nextEvents.splice(targetIndex, 0, event)
  }

  return nextEvents
}

function newScheduledEvent(sceneId = ''): ScheduledEvent {
  return {
    id: uuidv4(),
    hour: 23,
    minute: 59,
    weekday: 0,
    event: 'setCurrentScene',
    payload: { sceneId, state: {} },
  }
}
