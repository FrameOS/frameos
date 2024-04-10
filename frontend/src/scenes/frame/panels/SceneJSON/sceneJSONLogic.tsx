import { actions, connect, events, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import type { sceneJSONLogicType } from './sceneJSONLogicType'
import { frameLogic } from '../../frameLogic'
import { FrameScene } from '../../../../types'

export interface SceneJSONLogicProps {
  frameId: number
  sceneId: string | null
}

export const sceneJSONLogic = kea<sceneJSONLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'SceneJSON', 'sceneJSONLogic']),
  props({} as SceneJSONLogicProps),
  key((props) => `${props.frameId}/${props.sceneId}`),
  connect(({ frameId }: SceneJSONLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm']],
    actions: [frameLogic({ frameId }), ['updateScene']],
  })),
  actions({
    setEditedSceneJSON: (sceneJSON: string | null) => ({ sceneJSON }),
    saveChanges: true,
  }),
  reducers({
    editedSceneJSON: [
      null as string | null,
      {
        setEditedSceneJSON: (_, { sceneJSON }) => sceneJSON,
      },
    ],
  }),
  selectors({
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes ?? []],
    scene: [
      (s, p) => [s.scenes, p.sceneId],
      (scenes, sceneId): FrameScene | null => scenes?.find((scene) => scene.id === sceneId) ?? null,
    ],
    sceneJSON: [
      (s) => [s.scene, s.editedSceneJSON],
      (scene, editedSceneJSON): string => editedSceneJSON ?? JSON.stringify(scene, null, 2),
    ],
    hasChanges: [(s) => [s.sceneJSON, s.scene], (sceneJSON, scene) => sceneJSON !== JSON.stringify(scene, null, 2)],
    hasError: [
      (s) => [s.sceneJSON],
      (sceneJSON) => {
        if (sceneJSON === null) {
          return false
        }
        try {
          JSON.parse(sceneJSON)
          return false
        } catch {
          return true
        }
      },
    ],
    sceneName: [(s) => [s.scene], (scene) => scene?.name ?? 'Scene'],
  }),
  events(({ actions }) => ({
    afterMount: () => {
      actions.setEditedSceneJSON(null)
    },
  })),
  listeners(({ values, props, actions }) => ({
    saveChanges: async () => {
      try {
        if (!props.sceneId) {
          return
        }
        const scene = JSON.parse(values.sceneJSON)
        actions.updateScene(props.sceneId, scene)
      } catch {
        console.error('Cannot save invalid JSON')
      }
    },
  })),
])
