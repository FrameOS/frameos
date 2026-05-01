import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import type { appsLogicType } from './appsLogicType'
import { appsModel, categoryLabels } from '../../../../models/appsModel'
import { searchInText } from '../../../../utils/searchInText'
import { AppConfig, AppNodeData, SceneApp } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import { isJavaScriptCatalogApp, sceneAppsToAppConfigs } from '../../../../utils/sceneApps'

export const INLINE_CODE_NODE_KEYWORD = '__frameos_inline_code_node__'

export const INLINE_CODE_NODE_APP: AppConfig = {
  name: 'Inline code node',
  category: 'code',
  description: 'Run inline code directly in the diagram.',
}

export interface AppsLogicProps {
  frameId: number
}

export const appsLogic = kea<appsLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Apps', 'appsLogic']),
  props({} as AppsLogicProps),
  key((props) => props.frameId),
  connect(({ frameId }: AppsLogicProps) => ({
    actions: [frameLogic({ frameId }), ['updateScene']],
    values: [
      appsModel,
      ['apps as allApps'],
      frameLogic({ frameId }),
      ['frameForm'],
      panelsLogic({ frameId }),
      ['selectedSceneId'],
    ],
  })),
  actions({
    setSearch: (search: string) => ({ search }),
    deleteUnusedSceneApp: (keyword: string) => ({ keyword }),
  }),
  reducers({
    search: ['', { setSearch: (_, { search }) => search }],
  }),
  selectors({
    apps: [
      (s) => [s.search, s.allApps],
      (search, allApps): Record<string, AppConfig> => {
        return Object.fromEntries(
          Object.entries(allApps).filter(
            ([_, app]) =>
              app.category !== 'legacy' && (searchInText(search, app.name) || searchInText(search, app.description))
          )
        )
      },
    ],
    appsByCategory: [
      (s) => [s.apps, s.search],
      (apps: Record<string, AppConfig>, search): Record<string, Record<string, AppConfig>> => {
        const defaultEntries: Record<string, Record<string, AppConfig>> = Object.fromEntries(
          Object.keys(categoryLabels).map((c) => [c, {}])
        )
        if (searchInText(search, INLINE_CODE_NODE_APP.name) || searchInText(search, INLINE_CODE_NODE_APP.description)) {
          defaultEntries.code[INLINE_CODE_NODE_KEYWORD] = INLINE_CODE_NODE_APP
        }
        return Object.fromEntries(
          Object.entries(
            Object.entries(apps).reduce((acc, [keyword, app]) => {
              const category = isJavaScriptCatalogApp(keyword) ? 'code' : (app.category || 'other').toLowerCase()
              if (!acc[category]) {
                acc[category] = {}
              }
              acc[category][keyword] = app
              return acc
            }, defaultEntries)
          ).filter(([_, apps]) => Object.keys(apps).length > 0)
        )
      },
    ],
    sceneApps: [
      (s) => [s.frameForm, s.selectedSceneId],
      (frameForm, selectedSceneId): Record<string, AppConfig> => {
        const selectedScene = frameForm?.scenes?.find((scene) => scene.id === selectedSceneId)
        return sceneAppsToAppConfigs(selectedScene)
      },
    ],
    rawSceneApps: [
      (s) => [s.frameForm, s.selectedSceneId],
      (frameForm, selectedSceneId): Record<string, SceneApp> => {
        const selectedScene = frameForm?.scenes?.find((scene) => scene.id === selectedSceneId)
        return selectedScene?.apps ?? {}
      },
    ],
    sceneAppUsageCounts: [
      (s) => [s.frameForm, s.selectedSceneId],
      (frameForm, selectedSceneId): Record<string, number> => {
        const selectedScene = frameForm?.scenes?.find((scene) => scene.id === selectedSceneId)
        const sceneAppKeys = Object.keys(selectedScene?.apps ?? {})
        const counts = Object.fromEntries(sceneAppKeys.map((keyword) => [keyword, 0]))
        for (const node of selectedScene?.nodes ?? []) {
          if (node.type === 'app') {
            const keyword = (node.data as AppNodeData | undefined)?.keyword
            if (keyword && keyword in counts) {
              counts[keyword] += 1
            }
          }
        }
        return counts
      },
    ],
    visibleSceneApps: [
      (s) => [s.search, s.sceneApps],
      (search, sceneApps): Record<string, AppConfig> => {
        return Object.fromEntries(
          Object.entries(sceneApps).filter(
            ([_, app]) => !search || searchInText(search, app.name) || searchInText(search, app.description)
          )
        )
      },
    ],
    appsWithSaveAssets: [
      (s) => [s.apps],
      (apps: Record<string, AppConfig>): Record<string, string> => {
        return Object.fromEntries(
          Object.entries(apps)
            .filter(([_, app]) => app.fields?.some((f) => !('markdown' in f) && f.name === 'saveAssets'))
            .map(([k, v]) => [k, v.name])
        )
      },
    ],
  }),
  listeners(({ actions, values }) => ({
    deleteUnusedSceneApp: ({ keyword }) => {
      if (!values.selectedSceneId || values.sceneAppUsageCounts[keyword] !== 0) {
        return
      }
      const { [keyword]: _deleted, ...apps } = values.rawSceneApps
      actions.updateScene(values.selectedSceneId, { apps })
    },
  })),
])
