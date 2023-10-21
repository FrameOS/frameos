import { actions, afterMount, connect, kea, key, listeners, path, props, propsChanged, reducers, selectors } from 'kea'

import type { editAppLogicType } from './editAppLogicType'
import { loaders } from 'kea-loaders'
import { frameLogic } from '../../frameLogic'
import { editor, MarkerSeverity } from 'monaco-editor'

export interface ModelMarker extends editor.IMarkerData {}

export interface EditAppLogicProps {
  frameId: number
  sceneId: string
  nodeId: string
  keyword: string
  sources?: Record<string, string>
}

export interface SourceError {
  line: number
  column: number
  error: string
}

export const editAppLogic = kea<editAppLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'EditApp', 'editAppLogic']),
  props({} as EditAppLogicProps),
  key((props) => `${props.frameId}:${props.sceneId}.${props.nodeId}.${props.keyword}`),
  connect((props: EditAppLogicProps) => ({
    actions: [frameLogic({ id: props.frameId }), ['updateNodeData']],
  })),
  actions({
    setActiveFile: (file: string) => ({ file }),
    updateFile: (file: string, source: string) => ({ file, source }),
    saveChanges: true,
    setInitialSources: (sources: Record<string, string>) => ({ sources }),
    validateSource: (file: string, source: string, initial: boolean = false) => ({ file, source, initial }),
    setSourceErrors: (file: string, errors: SourceError[]) => ({ file, errors }),
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
        setInitialSources: (_, { sources }) => sources,
      },
    ],
    sourceErrors: [
      {} as Record<string, SourceError[]>,
      {
        setSourceErrors: (state, { file, errors }) => ({ ...state, [file]: errors }),
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
    modelMarkers: [
      (s) => [s.sourceErrors],
      (sourceErrors): Record<string, ModelMarker[]> =>
        Object.fromEntries(
          Object.entries(sourceErrors).map(([file, errors]) => [
            file,
            errors.map((error) => ({
              startLineNumber: error.line,
              startColumn: error.column,
              endLineNumber: error.line,
              endColumn: error.column,
              message: error.error,
              severity: MarkerSeverity.Error,
            })),
          ])
        ),
    ],
  }),
  listeners(({ actions, props, values }) => ({
    saveChanges: () => {
      actions.updateNodeData(props.sceneId, props.nodeId, { sources: values.sources })
      actions.setInitialSources(values.sources)
    },
    setInitialSources: ({ sources }) => {
      for (const [file, source] of Object.entries(sources)) {
        actions.validateSource(file, source)
      }
    },
    updateFile: ({ file, source }) => {
      actions.validateSource(file, source)
    },
    validateSource: async ({ initial, file, source }, breakpoint) => {
      if (!initial) {
        await breakpoint(300)
      }
      const response = await fetch(`/api/validate_source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, source }),
      })
      const { errors } = await response.json()
      if (!initial) {
        breakpoint()
      }
      actions.setSourceErrors(file, errors || [])
    },
  })),
  afterMount(({ actions, props }) => {
    if (!props.sources) {
      actions.loadSources()
    }
  }),
])
