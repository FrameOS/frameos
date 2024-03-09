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
    setCurrentScene: (sceneId: string) => ({ sceneId }),
    currentSceneChanged: (sceneId: string) => ({ sceneId }),
  }),
  loaders(({ props, values }) => ({
    stateRecord: [
      {} as StateRecord,
      {
        sync: async (_, breakpoint) => {
          await breakpoint(100)
          try {
            const response = await fetch(`/api/frames/${props.frameId}/state`)
            if (!response.ok) {
              throw new Error('Failed to fetch logs')
            }
            return await response.json()
          } catch (error) {
            console.error(error)
            return values.stateRecord
          }
        },
      },
    ],
  })),
  reducers({
    stateRecord: [
      {} as StateRecord,
      {
        currentSceneChanged: (state, { sceneId }) => ({ ...state, sceneId }),
      },
    ],
    sceneChanging: [
      false,
      {
        setCurrentScene: () => true,
        syncSuccess: () => false,
        syncFailure: () => false,
        currentSceneChanged: () => false,
      },
    ],
  }),
  selectors({
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes],
    scene: [
      (s) => [s.scenes, s.sceneId],
      (scenes, sceneId): FrameScene | null => scenes?.find((scene) => scene.id === sceneId) ?? null,
    ],
    fields: [(s) => [s.scene], (scene) => (scene?.fields ?? []).filter((field) => field.access === 'public')],
    scenesAsOptions: [
      (s) => [s.scenes],
      (scenes): { label: string; value: string }[] =>
        (scenes ?? []).map((scene) => ({
          label: scene.name || 'Unnamed Scene',
          value: scene.id || '',
        })),
    ],
    state: [(s) => [s.stateRecord], (stateRecord) => stateRecord?.state ?? {}],
    sceneId: [(s) => [s.stateRecord], (stateRecord) => stateRecord?.sceneId ?? null],
    loading: [
      (s) => [s.stateRecord, s.sceneChanging, s.stateRecordLoading],
      (stateRecord, stateRecordLoading, sceneChanging) => !stateRecord?.sceneId || stateRecordLoading || sceneChanging,
    ],
  }),
  forms(({ values, props }) => ({
    stateChanges: {
      defaults: {} as Record<string, any>,
      submit: async (formValues) => {
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
        const response = await fetch(`/api/frames/${props.frameId}/event/setSceneState`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ render: true, state }),
        })
        await response.json()
      },
    },
  })),
  listeners(({ actions, props, values }) => ({
    setCurrentScene: async ({ sceneId }) => {
      const response = await fetch(`/api/frames/${props.frameId}/event/setCurrentScene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId }),
      })
      await response.text()
    },
    [socketLogic.actionTypes.newLog]: ({ log }) => {
      try {
        const { event, sceneId } = JSON.parse(log.line)
        if (event === 'sceneChange') {
          if (sceneId !== values.sceneId) {
            actions.currentSceneChanged(sceneId)
            actions.sync()
          } else {
            actions.currentSceneChanged(sceneId)
          }
        } else if (event === 'event:setSceneState') {
          actions.sync()
        }
        console.log({ event })
      } catch (error) {}
    },
  })),
  afterMount(({ actions }) => {
    actions.sync()
  }),
])
