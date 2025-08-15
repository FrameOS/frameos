import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { v4 as uuidv4 } from 'uuid'

import type { scheduleLogicType } from './scheduleLogicType'
import { FrameSchedule, ScheduledEvent, StateField } from '../../../../types'
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
    addEvent: () => ({ event: newScheduledEvent() }),
    editEvent: (id: string) => ({ id }),
    closeEvent: (id: string) => ({ id }),
    deleteEvent: (id: string) => ({ id }),
    toggleDescription: (id: string) => ({ id }),
    setSort: (sort: string) => ({ sort }),
  }),

  reducers({
    editingEvents: [
      {} as Record<string, boolean>,
      {
        addEvent: (state, { event }) => ({ ...state, [event.id]: true }),
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
    expandedDescriptions: [
      {} as Record<string, boolean>,
      {
        toggleDescription: (state, { id }) => ({ ...state, [id]: !state[id] }),
      },
    ],
    sort: [
      'hour' as string,
      {
        setSort: (_, { sort }) => sort,
      },
    ],
  }),

  selectors({
    schedule: [(s) => [s.frameForm, s.frame], (frameForm, frame) => frameForm.schedule ?? frame.schedule],
    events: [(s) => [s.schedule], (schedule) => schedule?.events ?? []],
    disabled: [(s) => [s.schedule], (schedule) => schedule?.disabled ?? false],
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes],
    sceneNames: [
      (s) => [s.scenes],
      (scenes): Record<string, string> =>
        (scenes ?? []).reduce((acc, scene) => {
          acc[scene.id] = scene.name || 'Unnamed Scene'
          return acc
        }, {} as Record<string, string>),
    ],
    scenesAsOptions: [
      (s) => [s.scenes],
      (scenes): { label: string; value: string }[] =>
        [{ label: '- Select Scene -', value: '' }].concat(
          (scenes ?? [])
            .map((scene) => ({
              label: scene.name || 'Unnamed Scene',
              value: scene.id || '',
            }))
            .toSorted((a, b) => a.label.localeCompare(b.label))
        ),
    ],
    fieldsForScene: [
      (s) => [s.frame, s.frameForm],
      (frame, frameForm): Record<string, StateField[]> =>
        (frameForm?.scenes ?? frame.scenes ?? []).reduce((acc, scene) => {
          acc[scene.id] = scene.fields ?? []
          return acc
        }, {} as Record<string, StateField[]>),
    ],
    sortedEvents: [
      (s) => [s.events, s.sort, s.sceneNames],
      (events, sort, sceneNames) => {
        if (sort === 'day') {
          return events.sort((a, b) => a.weekday - b.weekday)
        } else if (sort === 'hour') {
          return events.sort((a, b) => (a.hour === b.hour ? a.minute - b.minute : a.hour - b.hour))
        } else if (sort === 'scene') {
          return events.sort((a, b) =>
            (sceneNames[a.payload.sceneId ?? ''] || a.payload.sceneId).localeCompare(
              sceneNames[b.payload.sceneId ?? ''] || b.payload.sceneId
            )
          )
        }
        return events
      },
    ],
  }),

  listeners(({ actions, values }) => ({
    addEvent: ({ event }) => {
      actions.setFrameFormValues({ ...values.frameForm, schedule: { events: [...values.events, event] } })
    },
    deleteEvent: ({ id }) => {
      actions.setFrameFormValues({
        ...values.frameForm,
        schedule: { events: values.events.filter((event) => event.id !== id) },
      })
    },
  })),
])

function newScheduledEvent(): ScheduledEvent {
  return {
    id: uuidv4(),
    hour: 23,
    minute: 59,
    weekday: 0,
    event: 'setCurrentScene',
    payload: { sceneId: '', state: {} },
  }
}
