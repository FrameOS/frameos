import { actions, afterMount, connect, kea, key, listeners, path, props, propsChanged, reducers, selectors } from 'kea'

import type { editAppLogicType } from './editAppLogicType'
import { loaders } from 'kea-loaders'
import { Node } from 'reactflow'
import { frameLogic } from '../../frameLogic'
import { editor, MarkerSeverity } from 'monaco-editor'
import { AppNodeData } from '../../../../types'
import { appsLogic } from '../Apps/appsLogic'
import { apiFetch } from '../../../../utils/apiFetch'
import { diagramLogic } from '../Diagram/diagramLogic'
import { buildAppTypeDeclarations } from '../../../../utils/appTypeDeclarations'
import { buildSceneApp, forkSceneAppKey, isRepoAppKeyword, sceneAppToAppConfig } from '../../../../utils/sceneApps'

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

const primaryFiles = ['config.json', 'app.ts', 'app.js', 'app.nim']

export const editAppLogic = kea<editAppLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'EditApp', 'editAppLogic']),
  props({} as EditAppLogicProps),
  key((props) => `${props.frameId}:${props.sceneId}.${props.nodeId}`),
  connect(({ frameId, sceneId }: EditAppLogicProps) => ({
    actions: [frameLogic({ frameId }), ['updateNodeData', 'updateScene']],
    values: [
      frameLogic({ frameId }),
      ['frameForm'],
      appsLogic({ frameId }),
      ['apps'],
      diagramLogic({ frameId, sceneId }),
      ['scene'],
    ],
  })),
  actions({
    setActiveFile: (file: string) => ({ file }),
    updateFile: (file: string, source: string) => ({ file, source }),
    saveChanges: true,
    forkAndSaveChanges: true,
    setInitialSources: (sources: Record<string, string>) => ({ sources }),
    validateSource: (file: string, source: string, initial: boolean = false) => ({ file, source, initial }),
    setSourceErrors: (file: string, errors: SourceError[]) => ({ file, errors }),
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
    savedKeyword: [(s) => [s.appData], (appData): string | null => appData?.keyword || null],
    sceneAppKey: [
      (s) => [s.scene, s.savedKeyword],
      (scene, savedKeyword): string | null =>
        savedKeyword && (scene?.apps?.[savedKeyword] || isRepoAppKeyword(savedKeyword)) ? savedKeyword : null,
    ],
    sceneApp: [
      (s) => [s.scene, s.sceneAppKey],
      (scene, sceneAppKey) => (sceneAppKey ? scene?.apps?.[sceneAppKey] ?? null : null),
    ],
    isSceneApp: [(s) => [s.sceneAppKey], (sceneAppKey): boolean => !!sceneAppKey],
    savedSources: [
      (s) => [s.appData, s.sceneApp],
      (appData, sceneApp): Record<string, string> | null => appData?.sources || sceneApp?.sources || null,
    ],
    isInterpreted: [(s) => [s.scene], (scene): boolean => scene?.settings?.execution === 'interpreted'],
    appUsageCount: [
      (s) => [s.scene, s.sceneAppKey],
      (scene, sceneAppKey): number =>
        sceneAppKey
          ? (scene?.nodes ?? []).filter(
              (node) => node.type === 'app' && (node.data as AppNodeData | undefined)?.keyword === sceneAppKey
            ).length
          : 1,
    ],
    hasMultipleAppUsages: [(s) => [s.appUsageCount], (appUsageCount): boolean => appUsageCount > 1],
  }),
  loaders(({ actions, values }) => ({
    sources: [
      {} as Record<string, string>,
      {
        loadSources: async () => {
          const files = ['README.md', 'app.ts', 'app.js', 'app.nim', 'config.nim']
          let sources: Record<string, string> = {}
          if (values.savedSources) {
            sources = values.savedSources
          } else if (values.savedKeyword) {
            const response = await apiFetch(`/api/apps/source?keyword=${encodeURIComponent(values.savedKeyword)}`)
            sources = await response.json()
          }
          if (sources['app_loader.nim'] !== undefined) {
            const { ['app_loader.nim']: _ignored, ...filteredSources } = sources
            sources = filteredSources
          }
          for (const file of files) {
            if (file in sources) {
              actions.setActiveFile(file)
              break
            }
          }
          return sources
        },
      },
    ],
  })),
  reducers(({ props }) => ({
    activeFile: [
      '' as string,
      {
        setActiveFile: (_, { file }) => file,
        resetEnhanceSuggestion: (state) => (state === 'app.nim/suggestion' ? 'app.nim' : state),
        deleteFile: (state, { file }) => (state === file ? 'config.json' : state),
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
    isJavaScriptApp: [(s) => [s.sources], (sources): boolean => !!(sources['app.ts'] || sources['app.js'])],
    requiresCompiledOnSave: [
      (s) => [s.isInterpreted, s.isJavaScriptApp],
      (isInterpreted, isJavaScriptApp): boolean => isInterpreted && !isJavaScriptApp,
    ],
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
    appTypeDeclarations: [(s) => [s.configJson], (configJson): string => buildAppTypeDeclarations(configJson)],
    title: [
      (s, p) => [s.savedKeyword, p.nodeId, s.apps, s.sceneApp, s.configJson],
      (keyword, nodeId, apps, sceneApp, configJson): string =>
        configJson?.name || sceneApp?.name || (keyword ? apps[keyword]?.name || keyword : nodeId),
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
        const first = primaryFiles.filter((file) => filenames.includes(file))
        const rest = filenames.filter((f) => !primaryFiles.includes(f)).sort()
        return [...first, ...rest]
      },
    ],
  }),
  listeners(({ actions, props, values }) => ({
    saveChanges: () => {
      const settings = values.requiresCompiledOnSave
        ? { ...values.scene?.settings, execution: 'compiled' as const }
        : values.scene?.settings
      if (values.sceneAppKey) {
        const sceneApps = values.scene?.apps ?? {}
        actions.updateScene(props.sceneId, {
          apps: {
            ...sceneApps,
            [values.sceneAppKey]: buildSceneApp(
              values.sceneAppKey,
              values.apps[values.sceneAppKey],
              values.sources,
              values.sceneApp ?? undefined
            ),
          },
          settings,
        })
      } else {
        if (values.isInterpreted) {
          actions.updateScene(props.sceneId, { settings })
        }
        actions.updateNodeData(props.sceneId, props.nodeId, { sources: values.sources })
      }
      actions.setInitialSources(values.sources)
    },
    forkAndSaveChanges: () => {
      const keyword = values.sceneAppKey
      const scene = values.scene
      if (!keyword || !scene) {
        actions.saveChanges()
        return
      }

      const sceneApps = scene.apps ?? {}
      const app = values.apps[keyword] ?? (values.sceneApp ? sceneAppToAppConfig(values.sceneApp) : undefined)
      const newKeyword = forkSceneAppKey(sceneApps, keyword, app)
      const previous = values.sceneApp
        ? { ...values.sceneApp, source: values.sceneApp.source || keyword }
        : { source: keyword }
      const nodes = scene.nodes?.map((node) => {
        if (node.id !== props.nodeId || node.type !== 'app') {
          return node
        }
        const { sources: _sources, ...data } = (node.data ?? {}) as AppNodeData
        return { ...node, data: { ...data, keyword: newKeyword } }
      })

      actions.updateScene(props.sceneId, {
        apps: {
          ...sceneApps,
          [newKeyword]: buildSceneApp(newKeyword, app, values.sources, previous),
        },
        ...(nodes ? { nodes } : {}),
      })
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
