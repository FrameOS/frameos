import { actions, afterMount, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import type { editAppLogicType } from './editAppLogicType'
import { loaders } from 'kea-loaders'

export interface EditAppLogicProps {
  frameId: number
  sceneId: string
  nodeId: string
  keyword: string
  sources?: Record<string, string>
  setTitle?: (title: string) => void
  onChange?: (file: string, source: string) => void
}

export const editAppLogic = kea<editAppLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'EditApp', 'editAppLogic']),
  props({} as EditAppLogicProps),
  key((props) => `${props.frameId}:${props.sceneId}.${props.nodeId}.${props.keyword}`),
  actions({
    setActiveFile: (file: string) => ({ file }),
    updateFile: (file: string, source: string) => ({ file, source }),
  }),
  loaders(({ props, values }) => ({
    sources: [
      props.sources || ({} as Record<string, string>),
      {
        loadSources: async () => {
          if (!props.keyword) {
            return values.sources
          }
          const response = await fetch(`/api/apps/source/${encodeURIComponent(props.keyword as string)}`)
          return await response.json()
        },
      },
    ],
  })),
  reducers(({ props }) => ({
    activeFile: [
      'frame.py' as string,
      {
        setActiveFile: (state, { file }) => file,
      },
    ],
    sources: {
      updateFile: (state, { file, source }) => ({ ...state, [file]: source }),
    },
    initialSources: [
      props.sources ? structuredClone(props.sources) : ({} as Record<string, string>),
      {
        loadSourcesSuccess: (_, { sources }) => sources,
      },
    ],
  })),
  selectors({
    hasChanges: [
      (s) => [s.sources, s.sourcesLoading, s.initialSources],
      (sources, sourcesLoading, initialSources) => {
        if (sourcesLoading) {
          return false
        }
        return Object.entries(sources).some(([file, source]) => source !== initialSources[file])
      },
    ],
    changedFiles: [
      (s) => [s.sources, s.sourcesLoading, s.initialSources],
      (sources, sourcesLoading, initialSources): Record<string, boolean> => {
        return Object.fromEntries(
          Object.entries(sources).map(([file, source]) => [file, source !== initialSources[file]])
        )
      },
    ],
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
  }),
  listeners(({ props, values }) => ({
    updateFile: ({ file, source }) => {
      props.onChange?.(file, source)
      props.setTitle?.(values.hasChanges ? `* ${props.keyword}` : props.keyword)
    },
  })),
  afterMount(({ actions, props }) => {
    if (props.keyword) {
      actions.loadSources()
    }
  }),
])
