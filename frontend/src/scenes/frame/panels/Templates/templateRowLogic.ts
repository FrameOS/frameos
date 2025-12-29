import { actions, kea, key, path, props, reducers, selectors, listeners } from 'kea'
import { forms } from 'kea-forms'
import { SceneNodeData, TemplateType } from '../../../../types'
import { findConnectedScenes } from '../Scenes/utils'
import { apiFetch } from '../../../../utils/apiFetch'

import type { templateRowLogicType } from './templateRowLogicType'

export interface TemplateRowLogicProps {
  frameId?: number
  template: TemplateType
}

export const templateRowLogic = kea<templateRowLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Templates', 'templateRowLogic']),
  props({} as TemplateRowLogicProps),
  key((props: TemplateRowLogicProps) => `${props.frameId ?? 'no-frame'}-${props.template.id ?? props.template.name}`),
  actions({
    tryScene: (state?: Record<string, any>) => ({ state }),
    setTryLoading: (tryLoading: boolean) => ({ tryLoading }),
    openTrySceneModal: true,
    closeTrySceneModal: true,
  }),
  reducers({
    tryLoading: [
      false,
      {
        setTryLoading: (_, { tryLoading }) => tryLoading,
      },
    ],
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
          if (field.name in formValues) {
            state[field.name] = String(formValues[field.name] ?? field.value)
          }
        }
        actions.tryScene(state)
      },
    },
  })),
  selectors({
    scenes: [() => [(_, props: TemplateRowLogicProps) => props.template?.scenes], (scenes) => scenes ?? []],
    trySceneStateAsStrings: [
      (s) => [s.trySceneState, s.trySceneFields],
      (trySceneState, trySceneFields) => {
        const state: Record<string, any> = {}
        for (const field of trySceneFields) {
          if (field.name in trySceneState) {
            state[field.name] = String(trySceneState[field.name] ?? field.value)
          }
        }
        return state
      },
    ],
    trySceneConfig: [
      (s) => [s.scenes],
      (scenes) => {
        const interpretedScenes = scenes.filter((scene) => scene.settings?.execution === 'interpreted')
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
    tryScene: async () => {
      if (!props.frameId || !values.trySceneConfig) {
        return
      }
      try {
        actions.setTryLoading(true)
        const payload: Record<string, any> = {
          scenes: values.trySceneConfig.payloadScenes,
          sceneId:
            values.trySceneConfig.payloadScenes.length > 1
              ? values.trySceneConfig.mainScene.id
              : values.trySceneConfig.payloadScenes[0]?.id,
        }
        if (Object.keys(values.trySceneStateAsStrings).length > 0) {
          payload.state = values.trySceneStateAsStrings
        }
        const response = await apiFetch(`/api/frames/${props.frameId}/upload_scenes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!response.ok) {
          const message = await response.text()
          alert(message || 'Failed to send scene to frame')
          return
        }
        actions.closeTrySceneModal()
      } catch (error) {
        console.error('Failed to send scene to frame', error)
        alert('Failed to send scene to frame')
      } finally {
        actions.setTryLoading(false)
      }
    },
  })),
])
