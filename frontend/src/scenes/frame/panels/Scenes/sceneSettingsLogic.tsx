import { connect, kea, key, path, props, selectors } from 'kea'
import { frameLogic } from '../../frameLogic'
import { FrameScene } from '../../../../types'
import type { sceneSettingsLogicType } from './sceneSettingsLogicType'

export interface SceneSettingsLogicProps {
  frameId: number
  sceneId: string | null
}

export const sceneSettingsLogic = kea<sceneSettingsLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'sceneSettingsLogic']),
  props({} as SceneSettingsLogicProps),
  key((props) => `${props.frameId}-${props.sceneId}`),
  connect(({ frameId }: SceneSettingsLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm']],
  })),
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
  }),
])
