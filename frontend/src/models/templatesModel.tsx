import { actions, afterMount, kea, listeners, path, reducers, selectors } from 'kea'

import type { templatesModelType } from './templatesModelType'
import { loaders } from 'kea-loaders'
import { TemplateType } from '../types'

export const templatesModel = kea<templatesModelType>([
  path(['src', 'models', 'templatesModel']),
  actions({
    updateTemplate: (template: TemplateType) => ({ template }),
    removeTemplate: (id: string) => ({ id }),
    exportTemplate: (id: string, format?: string) => ({ id, format }),
  }),
  loaders(({ values }) => ({
    templates: [
      [] as TemplateType[],
      {
        loadTemplates: async () => {
          try {
            const response = await fetch('/api/templates')
            if (!response.ok) {
              throw new Error('Failed to fetch templates')
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
  listeners(({ values }) => ({
    exportTemplate: async ({ id, format }) => {
      const response = await fetch(`/api/templates/${id}/export${format ? `?format=${format}` : ''}`)
      if (!response.ok) {
        throw new Error('Failed to export template')
      }
      let blob: Blob
      let title: string = 'Exported Template'
      const template = values.templates?.find((t) => t.id === id)
      if (template) {
        title = template.name
      }
      if (format === 'zip') {
        blob = await response.blob()
      } else {
        const jsonData = await response.json()
        const jsonString: string = JSON.stringify(jsonData, null, 2)
        blob = new Blob([jsonString], { type: format === 'zip' ? 'application/zip' : 'application/json' })
        if (jsonData.name) {
          title = jsonData.name
        }
      }
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title}.${format || 'json'}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    },
  })),
  afterMount(({ actions }) => {
    actions.loadTemplates()
  }),
])
