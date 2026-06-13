import { actions, connect, kea, key, path, props, reducers, selectors, listeners } from 'kea'
import { forms } from 'kea-forms'
import { SceneNodeData, TemplateType } from '../../../../types'
import { findConnectedScenes } from '../Scenes/utils'
import { apiFetch } from '../../../../utils/apiFetch'
import { longRunningTasksModel } from '../../../../models/longRunningTasksModel'
import { framesModel } from '../../../../models/framesModel'
import { frameRunsScenesInterpreted } from '../../../../utils/sceneExecution'

import type { templateRowLogicType } from './templateRowLogicType'

export interface TemplateRowLogicProps {
  frameId?: number
  template: TemplateType
}

export const templateRowLogic = kea<templateRowLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Templates', 'templateRowLogic']),
  props({} as TemplateRowLogicProps),
  key((props: TemplateRowLogicProps) => `${props.frameId ?? 'no-frame'}-${props.template.id ?? props.template.name}`),
  connect({
    values: [framesModel, ['frames']],
  }),
  actions({
    tryScene: (state?: Record<string, any>) => ({ state }),
    openTrySceneModal: true,
    closeTrySceneModal: true,
  }),
  reducers({
    trySceneModalOpen: [
      false,
      {
        openTrySceneModal: () => true,
        closeTrySceneModal: () => false,
      },
    ],
  }),
  forms(({ values, props, actions }) => ({
    trySceneState: {
      defaults: {} as Record<string, any>,
      submit: async (formValues) => {
        if (!props.frameId || !values.trySceneConfig) {
          return
        }
        const state: Record<string, any> = {}
        for (const field of values.trySceneFields) {
          const value = formValues[field.name] ?? field.value
          if (value !== undefined && value !== null) {
            state[field.name] = String(value)
          }
        }
        actions.tryScene(state)
      },
    },
  })),
  selectors({
    scenes: [() => [(_, props: TemplateRowLogicProps) => props.template?.scenes], (scenes) => scenes ?? []],
    frameMode: [
      (s) => [s.frames, (_, props: TemplateRowLogicProps) => props.frameId],
      (frames, frameId: number | undefined) => (frameId ? frames[frameId]?.mode : undefined),
    ],
    trySceneConfig: [
      (s) => [s.scenes, s.frameMode],
      (scenes, frameMode) => {
        const interpretedScenes = frameRunsScenesInterpreted(frameMode)
          ? scenes
          : scenes.filter((scene) => scene.settings?.execution === 'interpreted')
        if (!interpretedScenes.length) {
          return null
        }
        const parentCounts = new Map<string, number>()
        for (const scene of scenes) {
          for (const node of scene.nodes) {
            if (node.type !== 'scene') {
              continue
            }
            const linkedSceneId = (node.data as SceneNodeData)?.keyword
            if (linkedSceneId) {
              parentCounts.set(linkedSceneId, (parentCounts.get(linkedSceneId) ?? 0) + 1)
            }
          }
        }

        let mainScene = interpretedScenes[0]
        let lowestParents = parentCounts.get(mainScene.id) ?? 0
        for (const scene of interpretedScenes.slice(1)) {
          const parents = parentCounts.get(scene.id) ?? 0
          if (parents < lowestParents) {
            lowestParents = parents
            mainScene = scene
          }
        }
        const connectedIds = new Set(findConnectedScenes(scenes, mainScene.id))
        const payloadScenes = scenes.filter((scene) => connectedIds.has(scene.id))
        return { mainScene, payloadScenes }
      },
    ],
    trySceneFields: [
      (s) => [s.trySceneConfig],
      (trySceneConfig) => (trySceneConfig?.mainScene?.fields ?? []).filter((field) => field.access === 'public'),
    ],
    defaultTrySceneState: [
      (s) => [s.trySceneFields],
      (trySceneFields) => {
        const defaults: Record<string, any> = {}
        for (const field of trySceneFields) {
          if (field.value !== undefined) {
            defaults[field.name] = field.value
          }
        }
        return defaults
      },
    ],
  }),
  listeners(({ actions, values, props }) => ({
    openTrySceneModal: () => {
      actions.resetTrySceneState(values.defaultTrySceneState)
    },
    tryScene: async ({ state }) => {
      if (!props.frameId || !values.trySceneConfig) {
        return
      }
      const sceneId =
        values.trySceneConfig.payloadScenes.length > 1
          ? values.trySceneConfig.mainScene.id
          : values.trySceneConfig.payloadScenes[0]?.id
      const detail = values.trySceneConfig.mainScene.name || props.template.name
      actions.closeTrySceneModal()
      longRunningTasksModel.actions.startTask({
        frameId: props.frameId,
        kind: 'preview',
        sceneId,
        title: 'Previewing scene',
        detail,
      })
      try {
        const payload: Record<string, any> = {
          scenes: values.trySceneConfig.payloadScenes,
          sceneId,
        }
        if (state && Object.keys(state).length > 0) {
          payload.state = state
        }
        const response = await apiFetch(`/api/frames/${props.frameId}/upload_scenes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!response.ok) {
          const message = await response.text()
          throw new Error(message || 'Failed to send scene to frame')
        }
      } catch (error) {
        console.error('Failed to send scene to frame', error)
        longRunningTasksModel.actions.taskFailed({
          frameId: props.frameId,
          kind: 'preview',
          sceneId,
          detail: error instanceof Error ? error.message : 'Failed to send scene to frame',
        })
      }
    },
  })),
])
