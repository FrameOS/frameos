import { afterMount, kea, path, selectors } from 'kea'

import type { templatesModelType } from './templatesModelType'
import { loaders } from 'kea-loaders'
import { App, TemplateType } from '../types'

export const templatesModel = kea<templatesModelType>([
  path(['src', 'models', 'templatesModel']),
  loaders(({ values }) => ({
    templates: [
      [] as TemplateType[],
      {
        loadTemplates: async () => {
          try {
            const response = await fetch('/api/templates')
            if (!response.ok) {
              throw new Error('Failed to fetch frames')
            }
            const data = await response.json()
            return data as TemplateType[]
          } catch (error) {
            console.error(error)
            return values.templates
          }
        },
      },
    ],
  })),
  afterMount(({ actions }) => {
    actions.loadTemplates()
  }),
])
