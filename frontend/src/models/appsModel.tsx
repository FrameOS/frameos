import { afterMount, kea, path, selectors } from 'kea'

import type { appsModelType } from './appsModelType'
import { loaders } from 'kea-loaders'
import { AppConfig } from '../types'
import { apiFetch } from '../utils/apiFetch'

export const categoryLabels: Record<string, any> = {
  render: 'Render',
  logic: 'Logic',
  data: 'Data',
}

export const appsModel = kea<appsModelType>([
  path(['src', 'models', 'appsModel']),
  loaders(({ values }) => ({
    apps: [
      {} as Record<string, AppConfig>,
      {
        loadApps: async () => {
          try {
            const response = await apiFetch('/api/apps')
            if (!response.ok) {
              throw new Error('Failed to fetch apps')
            }
            const data = await response.json()
            return data.apps as Record<string, AppConfig>
          } catch (error) {
            console.error(error)
            return values.apps
          }
        },
      },
    ],
  })),
  afterMount(({ actions }) => {
    actions.loadApps()
  }),
])
