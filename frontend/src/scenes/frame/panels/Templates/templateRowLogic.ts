import { actions, connect, kea, key, path, props, reducers, selectors, listeners } from 'kea'
import { FrameScene, RepositoryType, SceneNodeData, TemplateType } from '../../../../types'
import { findConnectedScenes } from '../Scenes/utils'
import { framesModel } from '../../../../models/framesModel'
import { frameRunsScenesInterpreted } from '../../../../utils/sceneExecution'
import { fetchTemplateScenes } from './templatesLogic'
import { livePreviewLogic } from '../Scenes/livePreviewLogic'

import type { templateRowLogicType } from './templateRowLogicType'

export interface TemplateRowLogicProps {
  frameId?: number
  template: TemplateType
  repository?: RepositoryType
}

export const templateRowLogic = kea<templateRowLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Templates', 'templateRowLogic']),
  props({} as TemplateRowLogicProps),
  key((props: TemplateRowLogicProps) => `${props.frameId ?? 'no-frame'}-${props.template.id ?? props.template.name}`),
  connect((props: TemplateRowLogicProps) => ({
    values: [framesModel, ['frames']],
    // Mount the frame's live-preview logic so the browser-preview submit can
    // drive it and the LivePreviewModal renders the same instance.
    logic: props.frameId ? [livePreviewLogic({ frameId: props.frameId })] : [],
  })),
  actions({
    startTryScene: true,
    setRemoteScenes: (scenes: FrameScene[]) => ({ scenes }),
  }),
  reducers({
    // Scenes fetched lazily from template.scenesUrl; repository listings only carry metadata.
    remoteScenes: [
      null as FrameScene[] | null,
      {
        setRemoteScenes: (_, { scenes }) => scenes,
      },
    ],
  }),
  selectors({
    scenes: [
      (s) => [(_, props: TemplateRowLogicProps) => props.template?.scenes, s.remoteScenes],
      (scenes, remoteScenes) => scenes ?? remoteScenes ?? [],
    ],
    canLoadRemoteScenes: [
      (s) => [(_, props: TemplateRowLogicProps) => props.template?.scenesUrl, s.remoteScenes],
      (scenesUrl, remoteScenes) => Boolean(scenesUrl) && remoteScenes === null,
    ],
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
  }),
  listeners(({ actions, values, props }) => ({
    startTryScene: async () => {
      if (values.scenes.length === 0 && values.canLoadRemoteScenes) {
        try {
          actions.setRemoteScenes(await fetchTemplateScenes(props.template))
        } catch (error) {
          console.error('Failed to load template scenes', error)
          return
        }
      }
      if (!props.frameId || !values.trySceneConfig) {
        return
      }
      // Open the in-browser WASM preview directly with the scene's default
      // public state; the preview modal itself offers "Preview on frame".
      // The scenes aren't installed on the frame, so pass them explicitly.
      const { mainScene, payloadScenes } = values.trySceneConfig
      const state: Record<string, any> = {}
      for (const field of values.trySceneFields) {
        if (field.value !== undefined && field.value !== null) {
          state[field.name] = String(field.value)
        }
      }
      livePreviewLogic({ frameId: props.frameId }).actions.openLivePreview(mainScene.id, state, payloadScenes, {
        template: props.template,
        repository: props.repository,
      })
    },
  })),
])
