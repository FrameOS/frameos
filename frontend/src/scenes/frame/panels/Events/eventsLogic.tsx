import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import type { eventsLogicType } from './eventsLogicType'
import { AppConfigField, FrameEvent, FrameScene } from '../../../../types'
import { searchInText } from '../../../../utils/searchInText'
import { frameEventsForScene } from '../../../../utils/frameEvents'
import { frameLogic } from '../../frameLogic'

export type EventsTab = 'listen' | 'dispatch' | 'custom'

export interface EventsLogicProps {
  frameId: number
  sceneId: string | null
}

export interface CustomEventRow {
  event: FrameEvent
  index: number
}

export const eventsLogic = kea<eventsLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Events', 'eventsLogic']),
  props({} as EventsLogicProps),
  key((props) => `${props.frameId}-${props.sceneId ?? 'none'}`),
  connect(({ frameId }: EventsLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm', 'frameFormErrors']],
    actions: [frameLogic({ frameId }), ['updateScene']],
  })),
  actions({
    showListen: true,
    showDispatch: true,
    showCustom: true,
    setSearch: (search: string) => ({ search }),
    setCustomEvents: (customEvents: FrameEvent[]) => ({ customEvents }),
    addCustomEvent: true,
    editCustomEvent: (index: number) => ({ index }),
    closeCustomEvent: (index: number) => ({ index }),
    removeCustomEvent: (index: number) => ({ index }),
    setCustomEventFields: (eventIndex: number, fields: AppConfigField[]) => ({ eventIndex, fields }),
    addCustomEventField: (eventIndex: number) => ({ eventIndex }),
    editCustomEventField: (eventIndex: number, fieldIndex: number) => ({ eventIndex, fieldIndex }),
    closeCustomEventField: (eventIndex: number, fieldIndex: number) => ({ eventIndex, fieldIndex }),
    removeCustomEventField: (eventIndex: number, fieldIndex: number) => ({ eventIndex, fieldIndex }),
  }),
  reducers({
    tab: [
      'listen' as EventsTab,
      {
        showListen: () => 'listen' as EventsTab,
        showDispatch: () => 'dispatch' as EventsTab,
        showCustom: () => 'custom' as EventsTab,
      },
    ],
    search: ['', { setSearch: (_, { search }) => search }],
    editingCustomEvents: [
      {} as Record<string, boolean>,
      {
        editCustomEvent: (state, { index }) => ({ ...state, [index]: true }),
        closeCustomEvent: (state, { index }) => ({ ...state, [index]: false }),
        removeCustomEvent: (state, { index }) =>
          Object.fromEntries(
            Object.entries(state)
              .filter(([key]) => parseInt(key) !== index)
              .map(([key, value]) => [parseInt(key) > index ? String(parseInt(key) - 1) : key, value])
          ),
      },
    ],
    editingCustomEventFields: [
      {} as Record<string, boolean>,
      {
        editCustomEventField: (state, { eventIndex, fieldIndex }) => ({
          ...state,
          [`${eventIndex}:${fieldIndex}`]: true,
        }),
        closeCustomEventField: (state, { eventIndex, fieldIndex }) => ({
          ...state,
          [`${eventIndex}:${fieldIndex}`]: false,
        }),
        removeCustomEventField: (state, { eventIndex, fieldIndex }) =>
          Object.fromEntries(
            Object.entries(state)
              .filter(([key]) => key !== `${eventIndex}:${fieldIndex}`)
              .map(([key, value]) => {
                const [rawEventIndex, rawFieldIndex] = key.split(':')
                const currentEventIndex = parseInt(rawEventIndex)
                const currentFieldIndex = parseInt(rawFieldIndex)
                if (currentEventIndex !== eventIndex || currentFieldIndex <= fieldIndex) {
                  return [key, value]
                }
                return [`${eventIndex}:${currentFieldIndex - 1}`, value]
              })
          ),
        removeCustomEvent: (state, { index }) =>
          Object.fromEntries(
            Object.entries(state)
              .filter(([key]) => parseInt(key.split(':')[0]) !== index)
              .map(([key, value]) => {
                const [rawEventIndex, rawFieldIndex] = key.split(':')
                const eventIndex = parseInt(rawEventIndex)
                return [eventIndex > index ? `${eventIndex - 1}:${rawFieldIndex}` : key, value]
              })
          ),
      },
    ],
  }),
  selectors({
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes ?? []],
    scene: [
      (s, p) => [s.scenes, p.sceneId],
      (scenes, sceneId): FrameScene | null => scenes?.find((scene) => scene.id === sceneId) ?? null,
    ],
    sceneIndex: [
      (s, p) => [s.scenes, p.sceneId],
      (scenes, sceneId): number => scenes?.findIndex((scene) => scene.id === sceneId) ?? 0,
    ],
    customEvents: [(s) => [s.scene], (scene): FrameEvent[] => scene?.customEvents ?? []],
    customEventRows: [
      (s) => [s.customEvents, s.search],
      (customEvents, search): CustomEventRow[] =>
        customEvents
          .map((event, index) => ({ event, index }))
          .filter(
            ({ event }) =>
              searchInText(search, event.name) || searchInText(search, event.description ?? '') || search === ''
          ),
    ],
    events: [
      (s) => [s.tab, s.search, s.scene],
      (tab, search, scene): FrameEvent[] => {
        return (
          tab === 'listen'
            ? frameEventsForScene(scene).filter((event) => event.canListen)
            : tab === 'dispatch'
            ? frameEventsForScene(scene).filter((event) => event.canDispatch)
            : []
        ).filter((event) => searchInText(search, event.name) || searchInText(search, event.description ?? ''))
      },
    ],
    tabCounts: [
      (s) => [s.search, s.scene, s.customEventRows],
      (search, scene, customEventRows): Record<EventsTab, number> => {
        const matchesSearch = (event: FrameEvent): boolean =>
          searchInText(search, event.name) || searchInText(search, event.description ?? '')
        const sceneEvents = frameEventsForScene(scene)
        return {
          listen: sceneEvents.filter((event) => event.canListen).filter(matchesSearch).length,
          dispatch: sceneEvents.filter((event) => event.canDispatch).filter(matchesSearch).length,
          custom: customEventRows.length,
        }
      },
    ],
    customEventsWithErrors: [
      (s) => [s.frameFormErrors, s.sceneIndex, s.customEvents],
      (
        frameFormErrors: Record<string, any>,
        sceneIndex: number,
        customEvents: FrameEvent[]
      ): Record<string, boolean> => {
        const errors = frameFormErrors.scenes?.[sceneIndex]?.customEvents ?? []
        return Object.fromEntries(
          customEvents.map((_event, index) => {
            const eventErrors = errors[index] ?? {}
            return [
              String(index),
              Object.entries(eventErrors).some(
                ([key, value]) =>
                  key !== 'fields' &&
                  (Boolean(value) || (typeof value === 'object' && Object.values(value ?? {}).some(Boolean)))
              ),
            ]
          })
        )
      },
    ],
    customEventFieldsWithErrors: [
      (s) => [s.frameFormErrors, s.sceneIndex, s.customEvents],
      (
        frameFormErrors: Record<string, any>,
        sceneIndex: number,
        customEvents: FrameEvent[]
      ): Record<string, boolean> => {
        const errors = frameFormErrors.scenes?.[sceneIndex]?.customEvents ?? []
        const result: Record<string, boolean> = {}
        customEvents.forEach((event, eventIndex) => {
          const fieldErrors = errors[eventIndex]?.fields ?? []
          const fields = event.fields ?? []
          fields.forEach((_field, fieldIndex) => {
            result[`${eventIndex}:${fieldIndex}`] = Object.values(fieldErrors[fieldIndex] ?? {}).some(Boolean)
          })
        })
        return result
      },
    ],
  }),
  listeners(({ values, actions, props }) => ({
    setCustomEvents: ({ customEvents }) => {
      if (props.sceneId) {
        actions.updateScene(props.sceneId, { customEvents })
      }
    },
    addCustomEvent: () => {
      const customEvents = values.customEvents ?? []
      actions.setSearch('')
      actions.setCustomEvents([
        ...customEvents,
        { name: '', description: '', fields: [], canListen: true, canDispatch: true },
      ])
      actions.editCustomEvent(customEvents.length)
      actions.showCustom()
    },
    removeCustomEvent: ({ index }) => {
      actions.setCustomEvents(values.customEvents.filter((_event, eventIndex) => eventIndex !== index))
    },
    setCustomEventFields: ({ eventIndex, fields }) => {
      actions.setCustomEvents(
        values.customEvents.map((event, index) =>
          index === eventIndex ? { ...event, fields, canListen: true, canDispatch: true } : event
        )
      )
    },
    addCustomEventField: ({ eventIndex }) => {
      const fields = values.customEvents[eventIndex]?.fields ?? []
      actions.setCustomEventFields(eventIndex, [...fields, { name: '', label: '', type: 'string' }])
      actions.editCustomEventField(eventIndex, fields.length)
    },
    removeCustomEventField: ({ eventIndex, fieldIndex }) => {
      const fields = values.customEvents[eventIndex]?.fields ?? []
      actions.setCustomEventFields(
        eventIndex,
        fields.filter((_field, index) => index !== fieldIndex)
      )
    },
  })),
])
