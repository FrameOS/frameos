import { actions, connect, kea, key, path, props, reducers, selectors } from 'kea'

import type { appsLogicType } from './appsLogicType'
import { appsModel, categoryLabels } from '../../../../models/appsModel'
import { searchInText } from '../../../../utils/searchInText'
import { AppConfig } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { panelsLogic } from '../panelsLogic'
import { sceneAppsToAppConfigs } from '../../../../utils/sceneApps'

export interface AppsLogicProps {
  frameId: number
}

export const appsLogic = kea<appsLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Apps', 'appsLogic']),
  props({} as AppsLogicProps),
  key((props) => props.frameId),
  connect(({ frameId }: AppsLogicProps) => ({
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
      (s) => [s.apps],
      (apps: Record<string, AppConfig>): Record<string, Record<string, AppConfig>> => {
        const defaultEntries: Record<string, Record<string, AppConfig>> = Object.fromEntries(
          Object.keys(categoryLabels).map((c) => [c, {}])
        )
        return Object.fromEntries(
          Object.entries(
            Object.entries(apps).reduce((acc, [keyword, app]) => {
              const category = (app.category || 'other').toLowerCase()
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
])
