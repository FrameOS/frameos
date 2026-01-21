import { actions, connect, kea, path, reducers, selectors } from 'kea'

import type { appsLogicType } from './appsLogicType'
import { appsModel, categoryLabels } from '../../../../models/appsModel'
import { searchInText } from '../../../../utils/searchInText'
import { AppConfig } from '../../../../types'

export const appsLogic = kea<appsLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Apps', 'appsLogic']),
  connect(() => ({
    values: [appsModel, ['apps as allApps']],
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
