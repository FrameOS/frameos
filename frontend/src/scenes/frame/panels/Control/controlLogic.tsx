import { actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import { frameLogic } from '../../frameLogic'

import { forms } from 'kea-forms'
import { FrameScene } from '../../../../types'

import { loaders } from 'kea-loaders'

import type { controlLogicType } from './controlLogicType'
import { socketLogic } from '../../../socketLogic'

export interface ControlLogicProps {
  frameId: number
}

export interface StateRecord {
  sceneId: string
  state: Record<string, any>
  fields: any[]
}

export const controlLogic = kea<controlLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'controlLogic']),
  props({} as ControlLogicProps),
  key((props) => props.frameId),
  connect(({ frameId }: ControlLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm']],
    actions: [frameLogic({ frameId }), ['updateScene', 'applyTemplate']],
  })),
  actions({
    sync: true,
    setSelectedSceneId: (sceneId: string) => ({ sceneId }),
    setCurrentSceneId: (sceneId: string) => ({ sceneId }),
  }),
  loaders(({ actions, props, values }) => ({
    stateRecords: [
      {} as Record<string, StateRecord>,
      {
        sync: async (_, breakpoint) => {
          await breakpoint(100)
          try {
            const { selectedSceneId, currentSceneId } = values
            const response = await fetch(
              `/api/frames/${props.frameId}/state` +
                (selectedSceneId ? `?sceneId=${encodeURIComponent(selectedSceneId)}` : '')
            )
            if (!response.ok) {
              throw new Error('Failed to sync state')
            }
            breakpoint()
            const json: StateRecord = await response.json()
            if (!selectedSceneId && json.sceneId && currentSceneId !== json.sceneId) {
              actions.setCurrentSceneId(json.sceneId)
              actions.setSelectedSceneId(json.sceneId)
            }
            return {
              ...values.stateRecords,
              [json.sceneId]: json,
            }
          } catch (error) {
            console.error(error)
            return values.stateRecords
          }
        },
      },
    ],
  })),
  reducers({
    selectedSceneId: [
      null as string | null,
      {
        setSelectedSceneId: (_, { sceneId }) => sceneId,
      },
    ],
    currentSceneId: [
      null as string | null,
      {
        setCurrentSceneId: (_, { sceneId }) => sceneId,
      },
    ],
    stateRecords: [
      {} as Record<string, StateRecord>,
      {
        setSelectedSceneId: (state, { sceneId }) =>
          sceneId in state ? state : { [sceneId]: { sceneId, state: {}, fields: [] } },
      },
    ],
    stateChanges: [
      {} as Record<string, Record<string, any>>,
      {
        setSelectedSceneId: (state, { sceneId }) => (sceneId in state ? state : { [sceneId]: {} }),
      },
    ],
  }),
  selectors({
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes ?? []],
    scene: [
      (s) => [s.scenes, s.selectedSceneId],
      (scenes, sceneId): FrameScene | null => scenes?.find((scene) => scene.id === sceneId) ?? null,
    ],
    fields: [(s) => [s.scene], (scene) => (scene?.fields ?? []).filter((field) => field.access === 'public')],
    state: [
      (s) => [s.stateRecords, s.selectedSceneId],
      (stateRecords, sceneId) => (sceneId && stateRecords[sceneId]?.state) || {},
    ],
    loading: [
      (s) => [s.selectedSceneId, s.stateRecords, s.stateRecordsLoading],
      (selectedSceneId, stateRecords, stateRecordLoading) =>
        (selectedSceneId && !stateRecords[selectedSceneId]) || stateRecordLoading,
    ],
    scenesAsOptions: [
      (s) => [s.scenes, s.selectedSceneId, s.currentSceneId],
      (scenes, selectedSceneId, currentSceneId): { label: string; value: string }[] => [
        ...(!selectedSceneId ? [{ label: '...', value: '' }] : []),
        ...(scenes ?? []).map((scene) => ({
          label: (scene.name || 'Unnamed Scene') + (currentSceneId === scene.id ? ' (active)' : ''),
          value: scene.id || '',
        })),
      ],
    ],
  }),
  forms(({ values, props }) => ({
    stateChanges: {
      defaults: {} as Record<string, Record<string, any>>,
      submit: async (_formValues) => {
        const formValues: Record<string, any> =
          (values.selectedSceneId ? _formValues[values.selectedSceneId] : null) ?? {}
        const state: Record<string, any> = {}
        const fields = values.scene?.fields ?? []
        for (const field of fields) {
          if (field.name in formValues && field.access === 'public') {
            if (field.type === 'boolean') {
              state[field.name] = formValues[field.name] === 'true' || field.value
            } else if (field.type === 'integer') {
              state[field.name] = parseInt(formValues[field.name] ?? field.value)
            } else if (field.type === 'float') {
              state[field.name] = parseFloat(formValues[field.name] ?? field.value)
            } else {
              state[field.name] = formValues[field.name] ?? field.value
            }
          }
        }
        const sceneId = values.selectedSceneId
        const response = await fetch(`/api/frames/${props.frameId}/event/setCurrentScene`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ render: true, sceneId, state }),
        })
        await response.json()
      },
    },
  })),
  listeners(({ actions, values }) => ({
    [socketLogic.actionTypes.newLog]: ({ log }) => {
      try {
        const { event, sceneId } = JSON.parse(log.line)
        if (event === 'sceneChange') {
          if (sceneId !== values.currentSceneId) {
            actions.setCurrentSceneId(sceneId)
            actions.sync()
          }
        } else if (event === 'event:setCurrentScene') {
          const { payload } = JSON.parse(log.line)
          const { sceneId, state } = payload ?? {}

          const currentChanges = values.stateChanges[sceneId] ?? {}

          // debugger

          actions.setStateChangesValues({
            stateChanges: {
              ...values.stateChanges,
              [sceneId]: {
                ...currentChanges,
                ...state,
              },
            },
          })
          // debugger
          if (sceneId !== values.currentSceneId) {
            actions.setCurrentSceneId(sceneId)
            actions.sync()
          }
        } else if (event === 'event:setSceneState') {
          actions.sync()
        }
      } catch (error) {}
    },
    setSelectedSceneId: () => {
      actions.sync()
    },
  })),

  afterMount(({ actions }) => {
    actions.sync()
  }),
])
