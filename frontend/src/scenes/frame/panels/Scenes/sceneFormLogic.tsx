import { afterMount, connect, kea, key, listeners, path, props, selectors } from 'kea'

import { loaders } from 'kea-loaders'
import { frameLogic } from '../../frameLogic'

import type { sceneFormLogicType } from './sceneFormLogicType'
import { forms } from 'kea-forms'
import { FrameScene } from '../../../../types'
import { subscriptions } from 'kea-subscriptions'

export interface SceneFormLogic {
  frameId: number
  sceneId: string
}

export const sceneFormLogic = kea<sceneFormLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'sceneFormLogic']),
  props({} as SceneFormLogic),
  key((props) => `${props.frameId}-${props.sceneId}`),
  connect(({ frameId }: SceneFormLogic) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm']],
    actions: [frameLogic({ frameId }), ['setFrameFormValues', 'applyTemplate']],
  })),
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
