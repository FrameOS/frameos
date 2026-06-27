import { connect, kea, key, path, props, selectors } from 'kea'

import type { expandedSceneLogicType } from './expandedSceneLogicType'
import { forms } from 'kea-forms'
import { apiFetch } from '../../../../utils/apiFetch'
import { FrameScene, FrameType } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { controlLogic } from './controlLogic'
import { longRunningTasksModel } from '../../../../models/longRunningTasksModel'
import { socketLogic } from '../../../socketLogic'

export interface ExpandedSceneLogicProps {
  frameId: number
  sceneId: string
  scene?: FrameScene | null
}

export const expandedSceneLogic = kea<expandedSceneLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'expandedSceneLogic']),
  props({} as ExpandedSceneLogicProps),
  key((props) => `${props.frameId}${props.sceneId}`),
  connect(({ frameId }: ExpandedSceneLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm'], controlLogic({ frameId }), ['states', 'loading']],
    actions: [frameLogic({ frameId }), ['updateScene', 'applyTemplate']],
  })),
  forms(({ values, props }) => ({
    stateChanges: {
      defaults: {} as Record<string, any>,
      submit: async (formValues) => {
        longRunningTasksModel.actions.startTask({
          frameId: props.frameId,
          kind: 'activate',
          sceneId: props.sceneId,
          title: 'Activating scene',
          detail: values.scene?.name || props.sceneId,
        })
        const state: Record<string, any> = {}
        const fields = values.scene?.fields ?? []
        try {
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
          if (!response.ok) {
            throw new Error('Failed to send scene activation event')
          }
          await response.json()
          controlLogic({ frameId: props.frameId }).actions.currentSceneChanged(props.sceneId)
          socketLogic.actions.updateFrame({ id: props.frameId, active_scene_id: props.sceneId } as FrameType)
          longRunningTasksModel.actions.finishTask({
            frameId: props.frameId,
            kind: 'activate',
            sceneId: props.sceneId,
            status: 'success',
            detail: values.scene?.name || props.sceneId,
          })
        } catch (error) {
          longRunningTasksModel.actions.taskFailed({
            frameId: props.frameId,
            kind: 'activate',
            sceneId: props.sceneId,
            detail: error instanceof Error ? error.message : 'Failed to activate scene',
          })
          throw error
        }
      },
    },
  })),
  selectors({
    scenes: [(s) => [s.frame, s.frameForm], (frame, frameForm) => frameForm.scenes ?? frame.scenes],
    scene: [
      (s) => [s.scenes, (_, p) => p.sceneId, (_, p) => p.scene],
      (scenes, sceneId, sceneOverride): FrameScene | null =>
        sceneOverride ?? scenes?.find((scene) => scene.id === sceneId) ?? null,
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
    hasStateChanges: [
      (s) => [s.stateChanges, s.loading, s.states, (_, props) => props.sceneId],
      (stateChanges, loading, states, sceneId) => {
        if (loading && !states) {
          return false
        }
        const currentState = states[sceneId] ?? {}
        return Object.keys(stateChanges).some((key) => stateChanges[key] !== currentState[key])
      },
    ],
  }),
])
