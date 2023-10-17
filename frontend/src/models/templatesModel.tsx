import { actions, afterMount, kea, path, reducers, selectors } from 'kea'

import type { templatesModelType } from './templatesModelType'
import { loaders } from 'kea-loaders'
import { App, TemplateType } from '../types'

export const templatesModel = kea<templatesModelType>([
  path(['src', 'models', 'templatesModel']),
  actions({
    updateTemplate: (template: TemplateType) => ({ template }),
    removeTemplate: (id: number) => ({ id }),
  }),
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
        removeTemplate: async ({ id }) => {
          try {
            const response = await fetch(`/api/templates/${id}`, { method: 'DELETE' })
            if (!response.ok) {
              throw new Error('Failed to remove template')
            }
            return values.templates.filter((t) => t.id !== id)
          } catch (error) {
            console.error(error)
            return values.templates
          }
        },
      },
    ],
  })),
  reducers({
    templates: {
      updateTemplate: (state, { template }) => {
        const index = state.findIndex((t) => t.id === template.id)
        if (index === -1) {
          return [...state, template]
        }
        return [...state.slice(0, index), template, ...state.slice(index + 1)]
      },
    },
  }),
  afterMount(({ actions }) => {
    actions.loadTemplates()
  }),
])
