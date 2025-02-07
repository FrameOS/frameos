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
  }),

  selectors({
    schedule: [(s) => [s.frameForm, s.frame], (frameForm, frame) => frameForm.schedule ?? frame.schedule],
    events: [(s) => [s.schedule], (schedule) => schedule?.events ?? []],
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes],
    scenesAsOptions: [
      (s) => [s.scenes],
      (scenes): { label: string; value: string }[] =>
        [{ label: '- Select Scene -', value: '' }].concat(
          (scenes ?? []).map((scene) => ({
            label: scene.name || 'Unnamed Scene',
            value: scene.id || '',
          }))
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
    hour: '9',
    minute: '0',
    weekday: '',
    event: 'setCurrentScene',
    payload: { sceneId: '', state: {} },
  }
}
