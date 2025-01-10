import { afterMount, kea, path, selectors } from 'kea'

import type { fontsModelType } from './fontsModelType'
import { loaders } from 'kea-loaders'
import { FontMetadata } from '../types'
import { apiFetch } from '../utils/apiFetch'

export const categoryLabels: Record<string, any> = {
  render: 'Render',
  logic: 'Logic',
  data: 'Data',
}

export const fontsModel = kea<fontsModelType>([
  path(['src', 'models', 'fontsModel']),
  loaders(({ values }) => ({
    fonts: [
      [] as FontMetadata[],
      {
        loadFonts: async () => {
          try {
            const response = await apiFetch('/api/fonts')
            if (!response.ok) {
              throw new Error('Failed to fetch fonts')
            }
            const data = await response.json()
            return data.fonts as FontMetadata[]
          } catch (error) {
            console.error(error)
            return values.fonts
          }
        },
      },
    ],
  })),
  selectors({
    fontsOptions: [
      (s) => [s.fonts],
      (fonts): { label: string; value: string }[] =>
        fonts.map((font) => ({
          label: font.name,
          value: font.file,
        })),
    ],
  }),
  afterMount(({ actions }) => {
    actions.loadFonts()
  }),
])
