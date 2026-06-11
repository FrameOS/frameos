import { actions, BuiltLogic, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { AppNodeData } from '../../types'

import type { frameEditorsLogicType } from './frameEditorsLogicType'
import { frameLogic } from './frameLogic'

// Tracks what is being edited in a frame's workspace: which editors (scene
// diagram, scene JSON, app source) are open, which one is active, and the
// last selected scene. chatLogic derives its chat context from this and
// diagramLogic uses it to scope global keyboard shortcuts to the visible
// scene. (This replaced the old four-area "panels" layout logic.)
export interface FrameEditorsLogicProps {
  frameId: number
}

export interface AnyBuiltLogic extends BuiltLogic {}

export type FrameEditorKind = 'diagram' | 'sceneJSON' | 'editApp'

export interface FrameEditor {
  kind: FrameEditorKind
  key: string
  sceneId: string
  nodeId?: string
  nodeData?: AppNodeData
  title?: string
}

export function diagramEditorKey(sceneId: string): string {
  return `diagram:${sceneId}`
}

export function sceneJSONEditorKey(sceneId: string): string {
  return `sceneJSON:${sceneId}`
}

export function editAppEditorKey(sceneId: string, nodeId: string): string {
  return `editApp:${sceneId}.${nodeId}`
}

function upsertEditor(editors: FrameEditor[], editor: FrameEditor): FrameEditor[] {
  return editors.find((e) => e.key === editor.key)
    ? editors.map((e) => (e.key === editor.key ? editor : e))
    : [...editors, editor]
}

export const frameEditorsLogic = kea<frameEditorsLogicType>([
  path(['src', 'scenes', 'frame', 'frameEditorsLogic']),
  props({} as FrameEditorsLogicProps),
  key((props) => props.frameId),
  connect((props: FrameEditorsLogicProps) => ({
    values: [frameLogic(props), ['frameForm']],
  })),
  actions({
    selectScene: (sceneId: string) => ({ sceneId }),
    editScene: (sceneId: string) => ({ sceneId }),
    editSceneJSON: (sceneId: string) => ({ sceneId }),
    editApp: (sceneId: string, nodeId: string, nodeData: AppNodeData) => ({ sceneId, nodeId, nodeData }),
    closeEditor: (editorKey: string) => ({ editorKey }),
    closeSceneEditors: (sceneIds: string[]) => ({ sceneIds }),
    persistUntilClosed: (editorKey: string, logic: AnyBuiltLogic) => ({ editorKey, logic }),
  }),
  reducers({
    openEditors: [
      [] as FrameEditor[],
      {
        editScene: (state, { sceneId }) =>
          upsertEditor(state, { kind: 'diagram', key: diagramEditorKey(sceneId), sceneId }),
        editSceneJSON: (state, { sceneId }) =>
          upsertEditor(state, { kind: 'sceneJSON', key: sceneJSONEditorKey(sceneId), sceneId }),
        editApp: (state, { sceneId, nodeId, nodeData }) =>
          upsertEditor(state, {
            kind: 'editApp',
            key: editAppEditorKey(sceneId, nodeId),
            sceneId,
            nodeId,
            nodeData,
            title: nodeData.name || nodeData.keyword || nodeId,
          }),
        closeEditor: (state, { editorKey }) => state.filter((editor) => editor.key !== editorKey),
        closeSceneEditors: (state, { sceneIds }) => state.filter((editor) => !sceneIds.includes(editor.sceneId)),
      },
    ],
    activeEditorKey: [
      null as string | null,
      {
        editScene: (_, { sceneId }) => diagramEditorKey(sceneId),
        editSceneJSON: (_, { sceneId }) => sceneJSONEditorKey(sceneId),
        editApp: (_, { sceneId, nodeId }) => editAppEditorKey(sceneId, nodeId),
        closeEditor: (state, { editorKey }) => (state === editorKey ? null : state),
      },
    ],
    lastSelectedScene: [
      null as string | null,
      {
        selectScene: (_, { sceneId }) => sceneId,
        editScene: (_, { sceneId }) => sceneId,
        editSceneJSON: (_, { sceneId }) => sceneId,
      },
    ],
  }),
  selectors(() => ({
    activeEditor: [
      (s) => [s.openEditors, s.activeEditorKey],
      (openEditors, activeEditorKey): FrameEditor | null =>
        activeEditorKey ? openEditors.find((editor) => editor.key === activeEditorKey) ?? null : null,
    ],
    scenesOpen: [(s) => [s.activeEditor], (activeEditor): boolean => !activeEditor],
    activeSceneEditorId: [
      (s) => [s.activeEditor],
      (activeEditor): string | null =>
        activeEditor && (activeEditor.kind === 'diagram' || activeEditor.kind === 'sceneJSON')
          ? activeEditor.sceneId
          : null,
    ],
    activeEditApp: [
      (s) => [s.activeEditor],
      (activeEditor): FrameEditor | null => (activeEditor?.kind === 'editApp' ? activeEditor : null),
    ],
    selectedSceneId: [
      (s) => [s.frameForm, s.lastSelectedScene, s.activeSceneEditorId],
      (frameForm, lastSelectedScene, activeSceneEditorId): string | null =>
        lastSelectedScene ??
        activeSceneEditorId ??
        frameForm?.scenes?.find((s) => s.default)?.id ??
        frameForm?.scenes?.[0]?.id ??
        null,
    ],
    selectedSceneName: [
      (s) => [s.frameForm, s.selectedSceneId],
      (frameForm, selectedSceneId): string | null =>
        selectedSceneId ? frameForm?.scenes?.find((s) => s.id === selectedSceneId)?.name ?? null : null,
    ],
    selectedSceneIsInterpreted: [
      (s) => [s.frameForm, s.selectedSceneId],
      (frameForm, selectedSceneId): boolean =>
        !!selectedSceneId &&
        (frameForm?.scenes?.find((scene) => scene.id === selectedSceneId)?.settings?.execution ?? 'compiled') ===
          'interpreted',
    ],
  })),
  listeners(({ cache }) => ({
    persistUntilClosed: ({ editorKey, logic }) => {
      if (!cache.closeListeners) {
        cache.closeListeners = {} as Record<string, () => void>
      }
      if (!cache.closeListeners[editorKey]) {
        cache.closeListeners[editorKey] = logic.mount()
      }
    },
    closeEditor: ({ editorKey }) => {
      if (cache.closeListeners?.[editorKey]) {
        cache.closeListeners[editorKey]()
        delete cache.closeListeners[editorKey]
      }
    },
    closeSceneEditors: ({ sceneIds }) => {
      for (const sceneId of sceneIds) {
        for (const editorKey of Object.keys(cache.closeListeners ?? {})) {
          if (
            editorKey === diagramEditorKey(sceneId) ||
            editorKey === sceneJSONEditorKey(sceneId) ||
            editorKey.startsWith(`editApp:${sceneId}.`)
          ) {
            cache.closeListeners[editorKey]()
            delete cache.closeListeners[editorKey]
          }
        }
      }
    },
  })),
])
