import { actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import { frameLogic } from '../../frameLogic'

import { forms } from 'kea-forms'
import { FrameScene } from '../../../../types'
import { subscriptions } from 'kea-subscriptions'

import type { sceneStateLogicType } from './sceneStateLogicType'
import { loaders } from 'kea-loaders'

export interface SceneStateLogicProps {
  frameId: number
  sceneId: string
}

export const sceneStateLogic = kea<sceneStateLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'sceneStateLogic']),
  props({} as SceneStateLogicProps),
  key((props) => `${props.frameId}-${props.sceneId}`),
  connect(({ frameId }: SceneStateLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm']],
    actions: [frameLogic({ frameId }), ['setFrameFormValues', 'applyTemplate']],
  })),
  actions({
    sync: true,
    editFields: true,
    resetFields: true,
  }),
  reducers({
    editingFields: [
      false,
      {
        editFields: () => true,
        resetFields: () => false,
        submitSceneFormSuccess: () => false,
      },
    ],
  }),
  selectors({
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes],
    scene: [
      (s, p) => [s.scenes, p.sceneId],
      (scenes, sceneId): FrameScene | null => scenes?.find((scene) => scene.id === sceneId) ?? null,
    ],
  }),
  forms(({ selectors, actions, values, props }) => ({
    sceneForm: {
      defaults: ((state: any) => {
        const def: Record<string, any> = selectors.scene(state) || {}
        return { id: def.id || '', name: def.name || '', fields: def.fields ?? [] }
      }) as any as Partial<FrameScene>,
      submit: async (formValues) => {
        actions.setFrameFormValues({
          scenes: values.scenes?.map((scene) => (scene.id === props.sceneId ? { ...scene, ...formValues } : scene)),
        })
      },
    },
    stateChanges: {
      defaults: {} as Record<string, any>,
      submit: async (formValues) => {
        const state: Record<string, any> = {}
        const fields = values.scene?.fields ?? []
        for (const field of fields) {
          if (field.access === 'public') {
            if (field.type === 'boolean') {
              state[field.name] = formValues[field.name] === 'true'
            } else if (field.type === 'integer') {
              state[field.name] = parseInt(formValues[field.name])
            } else if (field.type === 'float') {
              state[field.name] = parseFloat(formValues[field.name])
            } else {
              state[field.name] = formValues[field.name]
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
  listeners(({ values, actions }) => ({
    editFields: () => {
      const scene: Partial<FrameScene> = values.scene ?? {}
      actions.resetSceneForm({ id: scene.id || '', name: scene.name || '', fields: scene.fields ?? [] })
    },
    resetFields: () => {
      const scene: Partial<FrameScene> = values.scene ?? {}
      actions.resetSceneForm({ id: scene.id || '', name: scene.name || '', fields: scene.fields ?? [] })
    },
  })),
  loaders(({ props, values }) => ({
    state: [
      {} as Record<string, any>,
      {
        sync: async () => {
          try {
            const response = await fetch(`/api/frames/${props.frameId}/state`)
            if (!response.ok) {
              throw new Error('Failed to fetch logs')
            }
            return await response.json()
          } catch (error) {
            console.error(error)
            return values.state
          }
        },
      },
    ],
  })),
  afterMount(({ actions }) => {
    actions.sync()
  }),
])
