import { afterMount, kea, path, selectors } from 'kea'

import type { appsModelType } from './appsModelType'
import { loaders } from 'kea-loaders'
import { App } from '../types'

export const categoryLabels: Record<string, any> = {
  image: 'Image generation',
  overlay: 'Overlays',
  util: 'Utilities',
}

export const appsModel = kea<appsModelType>([
  path(['src', 'models', 'appsModel']),
  loaders(({ values }) => ({
    apps: [
      {} as Record<string, App>,
      {
        loadApps: async () => {
          try {
            const response = await fetch('/api/apps')
            if (!response.ok) {
              throw new Error('Failed to fetch frames')
            }
            const data = await response.json()
            return data.apps as Record<string, App>
          } catch (error) {
            console.error(error)
            return values.apps
          }
        },
      },
    ],
  })),
  selectors({
    appsByCategory: [
      (s) => [s.apps],
      (apps: Record<string, App>): Record<string, Record<string, App>> => {
        const defaultEntries: Record<string, Record<string, App>> = Object.fromEntries(
          Object.keys(categoryLabels).map((c) => [c, {}])
        )
        return Object.entries(apps).reduce((acc, [keyword, app]) => {
          const category = (app.category || 'other').toLowerCase()
          if (!acc[category]) {
            acc[category] = {}
          }
          acc[category][keyword] = app
          return acc
        }, defaultEntries)
      },
    ],
  }),
  afterMount(({ actions }) => {
    actions.loadApps()
  }),
])
