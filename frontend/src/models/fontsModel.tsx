import { actions, afterMount, kea, listeners, path, reducers, selectors } from 'kea'

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
  actions({
    loadFont: (font: FontMetadata) => ({ font }),
    setFontLoading: (font: FontMetadata, loading: boolean) => ({ font, loading }),
    setFontLoaded: (font: FontMetadata, loaded: boolean) => ({ font, loaded }),
  }),
  reducers({
    fontLoading: [
      {} as Record<string, boolean>,
      {
        setFontLoading: (state, { font, loading }) => ({ ...state, [font.file]: loading }),
      },
    ],
    fontLoaded: [
      {} as Record<string, boolean>,
      {
        setFontLoaded: (state, { font, loaded }) => ({ ...state, [font.file]: loaded }),
      },
    ],
    fontLoadAttempts: [
      {} as Record<string, number>,
      {
        setFontLoading: (state, { font, loading }) =>
          loading ? { ...state, [font.file]: (state[font.file] || 0) + 1 } : state,
      },
    ],
  }),
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
  listeners(({ values, actions }) => ({
    loadFont: async ({ font }, breakpoint) => {
      const loadAttempt = values.fontLoadAttempts[font.file]
      if (values.fontLoading[font.file] || values.fontLoaded[font.file] || loadAttempt >= 3) {
        return
      }
      try {
        if (loadAttempt > 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * loadAttempt))
        }
        actions.setFontLoading(font, true)
        const response = await apiFetch(`/api/fonts/${font.file}`)
        if (!response.ok) {
          throw new Error('Failed to fetch font')
        }
        const data = await response.blob()
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => {
            resolve(reader.result as string)
          }
          reader.readAsDataURL(data)
        })
        const style = document.createElement('style')
        const css = `@font-face { font-family: ${JSON.stringify(font.name)}; src: local(${JSON.stringify(
          font.name
        )}), url(${JSON.stringify(base64)}) format('truetype'); font-weight: ${font.weight || 400}; font-style: ${
          font.italic ? 'italic' : 'normal'
        }; }`
        style.appendChild(document.createTextNode(css))
        document.head.appendChild(style)
        actions.setFontLoaded(font, true)
      } catch (error) {
        console.error(error)
      } finally {
        actions.setFontLoading(font, false)
      }
    },
  })),
  selectors({
    fontsOptions: [
      (s) => [s.fonts],
      (fonts): { label: string; value: string }[] =>
        [
          { label: '- Default -', value: '' },
          ...fonts.map((font) => ({
            label: `${font.name} - ${font.weight} ${font.weight_title} ${font.italic ? 'Italic' : ''}`.trim(),
            value: font.file,
          })),
        ].sort((a, b) => a.label.localeCompare(b.label)),
    ],
    fontsByName: [
      (s) => [s.fonts],
      (fonts: FontMetadata[]): Record<string, FontMetadata[]> =>
        fonts.reduce((acc, font) => {
          if (!acc[font.name]) {
            acc[font.name] = []
          }
          acc[font.name].push(font)
          return acc
        }, {} as Record<string, FontMetadata[]>),
    ],
    fontsByNameOptions: [
      (s) => [s.fontsByName],
      (fontsByName): { label: string; value: string }[] => [
        { label: '- Default -', value: '' },
        ...Object.keys(fontsByName)
          .map((name) => ({
            label: name,
            value: name,
          }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      ],
    ],
    weightsByNameOptions: [
      (s) => [s.fontsByName],
      (fontsByName): Record<string, { label: string; value: string }[]> =>
        Object.fromEntries(
          Object.entries(fontsByName).map(([name, fonts]) => [
            name,
            fonts
              .toSorted((a, b) => a.weight + (a.italic ? 20 : 0) - (b.weight + (b.italic ? 20 : 0)))
              .map((font) => ({
                label: `${font.weight} ${font.weight_title} ${font.italic ? 'Italic' : ''}`.trim(),
                value: font.file,
              })),
          ])
        ),
    ],
  }),
  afterMount(({ actions }) => {
    actions.loadFonts()
  }),
])
