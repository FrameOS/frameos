import { actions, afterMount, connect, kea, key, listeners, path, props, propsChanged, reducers, selectors } from 'kea'

import type { editAppLogicType } from './editAppLogicType'
import { loaders } from 'kea-loaders'
import { Node } from 'reactflow'
import { frameLogic } from '../../frameLogic'
import { editor, MarkerSeverity } from 'monaco-editor'
import { AppNodeData } from '../../../../types'
import { appsLogic } from '../Apps/appsLogic'
import { apiFetch } from '../../../../utils/apiFetch'

export interface ModelMarker extends editor.IMarkerData {}

export interface EditAppLogicProps {
  frameId: number
  sceneId: string
  nodeId: string
}

export interface SourceError {
  line: number
  column: number
  error: string
}

export const editAppLogic = kea<editAppLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'EditApp', 'editAppLogic']),
  props({} as EditAppLogicProps),
  key((props) => `${props.frameId}:${props.sceneId}.${props.nodeId}`),
  connect(({ frameId }: EditAppLogicProps) => ({
    actions: [frameLogic({ frameId }), ['updateNodeData']],
    values: [frameLogic({ frameId }), ['frameForm'], appsLogic, ['apps']],
  })),
  actions({
    setActiveFile: (file: string) => ({ file }),
    updateFile: (file: string, source: string) => ({ file, source }),
    saveChanges: true,
    setInitialSources: (sources: Record<string, string>) => ({ sources }),
    validateSource: (file: string, source: string, initial: boolean = false) => ({ file, source, initial }),
    setSourceErrors: (file: string, errors: SourceError[]) => ({ file, errors }),
    enhance: true,
    setPrompt: (prompt: string) => ({ prompt }),
    resetEnhanceSuggestion: true,
    addFile: true,
    deleteFile: (file: string) => ({ file }),
  }),
  selectors({
    app: [
      (s, p) => [s.frameForm, p.sceneId, p.nodeId],
      (frameForm, sceneId, nodeId): Node<AppNodeData, 'app'> | null => {
        const scene = frameForm?.scenes?.find((scene) => scene.id === sceneId)
        const node = scene?.nodes?.find((node) => node.id === nodeId) as Node<AppNodeData, 'app'> | undefined
        return node ?? null
      },
    ],
    appData: [(s) => [s.app], (app): AppNodeData | null => app?.data || null],
    savedSources: [(s) => [s.appData], (appData): Record<string, string> | null => appData?.sources || null],
    savedKeyword: [(s) => [s.appData], (appData): string | null => appData?.keyword || null],
  }),
  loaders(({ props, values }) => ({
    sources: [
      {} as Record<string, string>,
      {
        loadSources: async () => {
          if (values.savedSources) {
            return values.savedSources
          }
          if (values.savedKeyword) {
            const response = await apiFetch(`/api/apps/source?keyword=${encodeURIComponent(values.savedKeyword)}`)
            return await response.json()
          }
          return {}
        },
      },
    ],
    enhanceSuggestion: [
      null as string | null,
      {
        enhance: async () => {
          const source = values.sources['app.nim']
          const prompt = values.prompt
          const response = await apiFetch(`/api/apps/enhance_source`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, source }),
          })
          const { suggestion, error } = await response.json()
          if (error) {
            return error.message || String(error)
          }
          return suggestion
        },
      },
    ],
  })),
  reducers(({ props }) => ({
    activeFile: [
      'app.nim' as string,
      {
        setActiveFile: (state, { file }) => file,
        resetEnhanceSuggestion: (state) => (state === 'app.nim/suggestion' ? 'app.nim' : state),
        deleteFile: (state, { file }) => (state === file ? 'app.nim' : state),
      },
    ],
    prompt: [
      'What can I improve here?' as string,
      {
        setPrompt: (_, { prompt }) => prompt,
      },
    ],
    sources: {
      updateFile: (state, { file, source }) => ({ ...state, [file]: source }),
      deleteFile: (state, { file }) => {
        const newState = { ...state }
        delete newState[file]
        return newState
      },
    },
    enhanceSuggestion: [
      null as string | null,
      {
        resetEnhanceSuggestion: () => null,
      },
    ],
    initialSources: [
      {} as Record<string, string>,
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
    title: [
      (s, p) => [s.savedKeyword, p.nodeId, s.apps, s.configJson],
      (keyword, nodeId, apps, configJson): string =>
        configJson?.name || (keyword ? apps[keyword]?.name || keyword : nodeId),
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
    filenames: [
      (s) => [s.sources],
      (sources): string[] => {
        const filenames = Object.keys(sources)
        const first = filenames.filter((f) => f === 'config.json' || f === 'app.nim').sort()
        const rest = filenames.filter((f) => f !== 'config.json' && f !== 'app.nim').sort()
        return [...first, ...rest]
      },
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
      const response = await apiFetch(`/api/apps/validate_source`, {
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
    enhanceSuccess: () => {
      actions.setActiveFile('app.nim/suggestion')
    },
    addFile: () => {
      const fileName = window.prompt('Enter file name')
      if (fileName) {
        actions.updateFile(fileName, '')
        actions.setActiveFile(fileName)
      }
    },
  })),
  afterMount(({ actions, values }) => {
    actions.loadSources()
  }),
])
