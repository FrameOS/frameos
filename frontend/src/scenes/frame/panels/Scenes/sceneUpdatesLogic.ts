import { actions, connect, kea, key, listeners, path, props, selectors } from 'kea'

import { FrameScene } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { repositoriesModel } from '../../../../models/repositoriesModel'
import { loadRepositoryTemplateScenes } from '../Templates/templatesLogic'
import {
  findTemplateForOrigin,
  sameTemplateOrigin,
  sceneOriginForTemplate,
  sceneUpdateVersion,
} from '../../../../utils/sceneOrigin'
import { remapSceneIds } from '../../../../utils/duplicateScenes'

import type { sceneUpdatesLogicType } from './sceneUpdatesLogicType'

export interface SceneUpdatesLogicProps {
  frameId: number
}

/**
 * "Update scene from repository" support for scene dropdowns. Kept separate
 * from scenesLogic on purpose: scenesLogic pulls in controlLogic, which syncs
 * the frame's state on mount — dropdowns on the frames home must not trigger
 * one such request per frame.
 */
export const sceneUpdatesLogic = kea<sceneUpdatesLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Scenes', 'sceneUpdatesLogic']),
  props({} as SceneUpdatesLogicProps),
  key((props) => props.frameId),
  connect(({ frameId }: SceneUpdatesLogicProps) => ({
    values: [frameLogic({ frameId }), ['frame', 'frameForm'], repositoriesModel, ['repositories']],
    actions: [frameLogic({ frameId }), ['updateScene']],
  })),
  actions({
    updateSceneFromRepo: (sceneId: string) => ({ sceneId }),
  }),
  selectors({
    installedScenes: [
      (s) => [s.frameForm, s.frame],
      (frameForm, frame): FrameScene[] => frameForm?.scenes ?? frame?.scenes ?? [],
    ],
    sceneUpdateVersions: [
      (s) => [s.installedScenes, s.repositories],
      (installedScenes, repositories): Record<string, string> => {
        const versions: Record<string, string> = {}
        for (const scene of installedScenes) {
          const version = sceneUpdateVersion(scene, repositories)
          if (version) {
            versions[scene.id] = version
          }
        }
        return versions
      },
    ],
  }),
  listeners(({ actions, values }) => ({
    updateSceneFromRepo: async ({ sceneId }) => {
      const installedScenes = values.installedScenes
      const scene = installedScenes.find((s) => s.id === sceneId)
      const origin = scene?.origin
      if (!scene || !origin) {
        return
      }
      const match = findTemplateForOrigin(values.repositories, origin)
      if (!match) {
        console.error('Cannot update scene: source template not found in any repository', origin)
        return
      }
      const { repository, template } = match
      const templateScenes = await loadRepositoryTemplateScenes(repository, template)

      // Multi-scene templates are updated as a group: every installed scene from
      // this template keeps its id, so links between scenes keep working.
      const installedIdByTemplateSceneId: Record<string, string> = {}
      for (const installed of installedScenes) {
        if (installed.origin?.sceneId && sameTemplateOrigin(installed.origin, origin)) {
          installedIdByTemplateSceneId[installed.origin.sceneId] = installed.id
        }
      }
      // Duplicated scenes share an origin; make sure the clicked scene claims its slot.
      if (origin.sceneId) {
        installedIdByTemplateSceneId[origin.sceneId] = scene.id
      }
      const remapped = remapSceneIds(templateScenes, (id) => installedIdByTemplateSceneId[id] ?? id)
      remapped.forEach((nextScene, index) => {
        const templateSceneId = templateScenes[index].id
        const installedId = installedIdByTemplateSceneId[templateSceneId]
        if (!installedId) {
          return
        }
        // Replace the scene's content but keep its id, name and default flag.
        actions.updateScene(installedId, {
          nodes: nextScene.nodes,
          edges: nextScene.edges,
          apps: nextScene.apps,
          fields: nextScene.fields,
          customEvents: nextScene.customEvents,
          settings: nextScene.settings,
          origin: sceneOriginForTemplate(repository, template, templateSceneId),
        })
      })
    },
  })),
])
