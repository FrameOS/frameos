import { connect, kea, key, path, props, selectors } from 'kea'

import type { expandedSceneLogicType } from './expandedSceneLogicType'
import { forms } from 'kea-forms'
import { apiFetch } from '../../../../utils/apiFetch'
import { FrameScene } from '../../../../types'
import { frameLogic } from '../../frameLogic'

export interface ExpandedSceneLogicProps {
  frameId: number
  sceneId: string
}

export const expandedSceneLogic = kea<expandedSceneLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'expandedSceneLogic']),
  props({} as ExpandedSceneLogicProps),
  key((props) => `${props.frameId}${props.sceneId}`),
  connect(({ frameId }: ExpandedSceneLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm']],
    actions: [frameLogic({ frameId }), ['updateScene', 'applyTemplate']],
  })),
  selectors({
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes],
    scene: [
      (s) => [s.scenes, (_, props) => props.sceneId],
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
        const response = await apiFetch(`/api/frames/${props.frameId}/event/setCurrentScene`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sceneId: props.sceneId, state }),
        })
        await response.json()
      },
    },
  })),
])
