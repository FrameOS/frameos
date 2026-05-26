import { actions, afterMount, kea, key, path, props, propsChanged, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'

import type { systemAppSourceLogicType } from './systemAppSourceLogicType'
import { apiFetch } from '../../utils/apiFetch'
import { buildAppTypeDeclarations } from '../../utils/appTypeDeclarations'

export interface SystemAppSourceLogicProps {
  keyword: string | null
}

const sourceLoadOrder = ['README.md', 'app.ts', 'app.js', 'app.tsx', 'app.jsx', 'app.nim', 'config.nim']
const primaryFiles = ['config.json', 'app.ts', 'app.js', 'app.tsx', 'app.jsx', 'app.nim']

function firstSourceFile(sources: Record<string, string>): string {
  for (const file of sourceLoadOrder) {
    if (file in sources) {
      return file
    }
  }
  return Object.keys(sources)[0] ?? ''
}

function withoutGeneratedSources(sources: Record<string, string>): Record<string, string> {
  if (sources['app_loader.nim'] === undefined) {
    return sources
  }
  const { ['app_loader.nim']: _ignored, ...filteredSources } = sources
  return filteredSources
}

export const systemAppSourceLogic = kea<systemAppSourceLogicType>([
  path(['src', 'scenes', 'workspace', 'systemAppSourceLogic']),
  props({} as SystemAppSourceLogicProps),
  key((props) => props.keyword ?? 'none'),
  actions({
    setActiveFile: (file: string) => ({ file }),
  }),
  loaders(({ actions, props }) => ({
    sources: [
      {} as Record<string, string>,
      {
        loadSources: async () => {
          if (!props.keyword) {
            actions.setActiveFile('')
            return {}
          }

          try {
            const response = await apiFetch(`/api/apps/source?keyword=${encodeURIComponent(props.keyword)}`)
            if (!response.ok) {
              throw new Error('Failed to fetch app sources')
            }
            const sources = withoutGeneratedSources((await response.json()) as Record<string, string>)
            actions.setActiveFile(firstSourceFile(sources))
            return sources
          } catch (error) {
            console.error(error)
            actions.setActiveFile('')
            return {}
          }
        },
      },
    ],
  })),
  reducers({
    activeFile: [
      '',
      {
        setActiveFile: (_, { file }) => file,
      },
    ],
  }),
  selectors({
    configJson: [
      (s) => [s.sources],
      (sources): Record<string, any> | null => {
        try {
          return JSON.parse(sources['config.json'])
        } catch (e) {
          return null
        }
      },
    ],
    appTypeDeclarations: [(s) => [s.configJson], (configJson): string => buildAppTypeDeclarations(configJson)],
    filenames: [
      (s) => [s.sources],
      (sources): string[] => {
        const filenames = Object.keys(sources)
        const first = primaryFiles.filter((file) => filenames.includes(file))
        const rest = filenames.filter((file) => !primaryFiles.includes(file)).sort()
        return [...first, ...rest]
      },
    ],
  }),
  propsChanged(({ actions, props }, oldProps) => {
    if (props.keyword !== oldProps.keyword) {
      actions.loadSources()
    }
  }),
  afterMount(({ actions }) => {
    actions.loadSources()
  }),
])
