import { connect, kea, key, path, props, selectors } from 'kea'

import { frameLogic } from '../../frameLogic'

import { forms } from 'kea-forms'
import { FrameScene } from '../../../../types'
import { subscriptions } from 'kea-subscriptions'

import type { sceneConfigLogicType } from './sceneConfigLogicType'

export interface SceneConfigLogicProps {
  frameId: number
  sceneId: string
}

export const sceneConfigLogic = kea<sceneConfigLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'sceneConfigLogic']),
  props({} as SceneConfigLogicProps),
  key((props) => `${props.frameId}-${props.sceneId}`),
  connect(({ frameId }: SceneConfigLogicProps) => ({
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
