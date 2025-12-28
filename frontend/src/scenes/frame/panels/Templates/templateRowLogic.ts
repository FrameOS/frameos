import { actions, kea, key, path, props, reducers, selectors, listeners } from 'kea'
import { TemplateType } from '../../../../types'
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
    tryScene: true,
    setTryLoading: (tryLoading: boolean) => ({ tryLoading }),
  }),
  reducers({
    tryLoading: [
      false,
      {
        setTryLoading: (_, { tryLoading }) => tryLoading,
      },
    ],
  }),
  selectors({
    scenes: [() => [(_, props: TemplateRowLogicProps) => props.template?.scenes], (scenes) => scenes ?? []],
    trySceneConfig: [
      (s) => [s.scenes],
      (scenes) => {
        const interpretedScenes = scenes.filter((scene) => scene.settings?.execution === 'interpreted')
        if (!interpretedScenes.length) {
          return null
        }
        const mainScene = interpretedScenes[0]
        const connectedIds = new Set(findConnectedScenes(scenes, mainScene.id))
        const payloadScenes = scenes.filter((scene) => connectedIds.has(scene.id))
        return { mainScene, payloadScenes }
      },
    ],
  }),
  listeners(({ actions, values, props }) => ({
    tryScene: async () => {
      if (!props.frameId || !values.trySceneConfig) {
        return
      }
      const payload =
        values.trySceneConfig.payloadScenes.length > 1
          ? values.trySceneConfig.payloadScenes
          : values.trySceneConfig.payloadScenes[0]
      try {
        actions.setTryLoading(true)
        const response = await apiFetch(`/api/frames/${props.frameId}/event/uploadScene`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!response.ok) {
          const message = await response.text()
          alert(message || 'Failed to send scene to frame')
        }
      } catch (error) {
        console.error('Failed to send scene to frame', error)
        alert('Failed to send scene to frame')
      } finally {
        actions.setTryLoading(false)
      }
    },
  })),
])
