import { actions, connect, kea, path, reducers, selectors } from 'kea'

import type { appsLogicType } from './appsLogicType'
import { appsModel, categoryLabels } from '../../../../models/appsModel'
import { searchInText } from '../../../../utils/searchInText'
import { App } from '../../../../types'

export const appsLogic = kea<appsLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Apps', 'appsLogic']),
  connect({
    values: [appsModel, ['apps as allApps']],
  }),
  actions({
    setSearch: (search: string) => ({ search }),
  }),
  reducers({
    search: ['', { setSearch: (_, { search }) => search }],
  }),
  selectors({
    apps: [
      (s) => [s.search, s.allApps],
      (search, allApps): Record<string, App> => {
        return Object.fromEntries(
          Object.entries(allApps).filter(
            ([_, app]) => searchInText(search, app.name) || searchInText(search, app.description)
          )
        )
      },
    ],
    appsByCategory: [
      (s) => [s.apps],
      (apps: Record<string, App>): Record<string, Record<string, App>> => {
        const defaultEntries: Record<string, Record<string, App>> = Object.fromEntries(
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
  }),
])
