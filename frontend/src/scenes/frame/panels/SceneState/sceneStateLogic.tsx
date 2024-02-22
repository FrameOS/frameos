import { actions, connect, kea, key, listeners, path, props, selectors } from 'kea'

import { frameLogic } from '../../frameLogic'

import { forms } from 'kea-forms'
import { FrameScene } from '../../../../types'

import type { sceneStateLogicType } from './sceneStateLogicType'

export interface SceneStateLogicProps {
  frameId: number
  sceneId: string | null
}

export const sceneStateLogic = kea<sceneStateLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'sceneStateLogic']),
  props({} as SceneStateLogicProps),
  key((props) => `${props.frameId}-${props.sceneId}`),
  connect(({ frameId }: SceneStateLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm']],
    actions: [frameLogic({ frameId }), ['updateScene', 'applyTemplate']],
  })),
  actions({
    resetFields: true,
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
        return { fields: def.fields ?? [] }
      }) as any as Partial<FrameScene>,
      errors: (state: any) => ({
        fields: (state.fields ?? []).map((field: Record<string, any>) => ({
          name: field.name ? '' : 'Name is required',
          label: field.label ? '' : 'Label is required',
          type: field.type ? '' : 'Type is required',
        })),
      }),
      submit: async (formValues) => {
        if (props.sceneId) {
          actions.updateScene(props.sceneId, formValues)
          actions.resetFields()
        }
      },
    },
  })),
  listeners(({ values, actions }) => ({
    resetFields: () => {
      const scene: Partial<FrameScene> = values.scene ?? {}
      actions.resetSceneForm({ id: scene.id || '', name: scene.name || '', fields: scene.fields ?? [] })
    },
  })),
])
