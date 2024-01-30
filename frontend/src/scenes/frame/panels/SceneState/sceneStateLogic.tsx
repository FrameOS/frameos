import { actions, connect, kea, key, path, props, reducers, selectors } from 'kea'

import { frameLogic } from '../../frameLogic'

import { forms } from 'kea-forms'
import { FrameScene } from '../../../../types'
import { subscriptions } from 'kea-subscriptions'

import type { sceneStateLogicType } from './sceneStateLogicType'

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
    editField: (fieldId: number) => ({ fieldId }),
    closeField: (fieldId: number) => ({ fieldId }),
  }),
  reducers({
    editingFields: [
      {} as Record<number, boolean>,
      {
        editField: (state, { fieldId }) => ({ ...state, [fieldId]: true }),
        closeField: (state, { fieldId }) => ({ ...state, [fieldId]: false }),
      },
    ],
  }),
  selectors({
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes],
    scene: [
      (s, p) => [s.scenes, p.sceneId],
      (scenes, sceneId) => scenes?.find((scene) => scene.id === sceneId) ?? null,
    ],
  }),
  forms(({ selectors }) => ({
    sceneForm: {
      defaults: ((state: any) => {
        const def: Record<string, any> = selectors.scene(state) || {}
        return { id: def.id || '', name: def.name || '', fields: def.fields ?? [] }
      }) as any as FrameScene,
    },
  })),
  subscriptions(({ actions, values, props }) => ({
    sceneForm: (sceneForm, oldSceneform) => {
      actions.setFrameFormValues({
        scenes: values.scenes?.map((scene) => (scene.id === props.sceneId ? { ...scene, ...sceneForm } : scene)),
      })
    },
  })),
])
