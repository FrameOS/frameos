import { actions, afterMount, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import type { sceneSourceLogicType } from './sceneSourceLogicType'
import { loaders } from 'kea-loaders'
import { frameLogic } from '../../frameLogic'
import { SourceError } from '../EditApp/editAppLogic'
import { editor, MarkerSeverity } from 'monaco-editor'

export interface ModelMarker extends editor.IMarkerData {}

export interface SceneSourceLogicProps {
  frameId: number
  sceneId: string | null
}

export const sceneSourceLogic = kea<sceneSourceLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'SceneSource', 'sceneSourceLogic']),
  props({} as SceneSourceLogicProps),
  key((props) => `${props.frameId}/${props.sceneId}`),
  connect(() => ({ actions: [frameLogic, ['submitFrameFormSuccess']] })),
  actions({
    setSourceErrors: (errors: SourceError[]) => ({ errors }),
    validateSource: (source: string) => ({ source }),
    updateSource: (source: string) => ({ source }),
  }),
  loaders(({ props }) => ({
    sceneSource: [
      '' as string,
      {
        loadSceneSource: async () => {
          if (!props.sceneId) {
            return ''
          }
          const response = await fetch(`/api/frames/${props.frameId}/scene_source/${props.sceneId}`)
          const result = await response.json()
          return result.source
        },
      },
    ],
  })),
  afterMount(({ actions }) => {
    actions.loadSceneSource()
  }),
  reducers({
    sceneSource: ['' as string, { updateSource: (_, { source }) => source }],
    sourceErrors: [
      [] as SourceError[],
      {
        setSourceErrors: (state, { errors }) => errors,
      },
    ],
  }),
  selectors({
    modelMarkers: [
      (s) => [s.sourceErrors],
      (sourceErrors): ModelMarker[] =>
        sourceErrors.map((error) => ({
          startLineNumber: error.line,
          startColumn: error.column,
          endLineNumber: error.line,
          endColumn: error.column,
          message: error.error,
          severity: MarkerSeverity.Error,
        })),
    ],
  }),
  listeners(({ actions }) => ({
    submitFrameFormSuccess: () => {
      actions.loadSceneSource()
    },
    loadSceneSourceSuccess: ({ sceneSource }) => {
      actions.validateSource(sceneSource)
    },
    updateSource: async ({ source }, breakpoint) => {
      await breakpoint(600)
      actions.validateSource(source)
    },
    validateSource: async ({ source }, breakpoint) => {
      const response = await fetch(`/api/apps/validate_source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'scene.nim', source }),
      })
      breakpoint()
      const { errors } = await response.json()
      actions.setSourceErrors(errors || [])
    },
  })),
])
