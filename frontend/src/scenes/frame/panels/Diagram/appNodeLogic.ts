import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import type { appNodeLogicType } from './appNodeLogicType'
import { diagramLogic, DiagramLogicProps } from './diagramLogic'
import { appsModel } from '../../../../models/appsModel'
import { App, ConfigField, DiagramNode, FrameEvent, MarkdownField } from '../../../../types'
import type { Edge } from '@reactflow/core/dist/esm/types/edges'

import _events from '../../../../../schema/events.json'
const events: FrameEvent[] = _events as any

export interface AppNodeLogicProps extends DiagramLogicProps {
  nodeId: string
}

export const appNodeLogic = kea<appNodeLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Diagram', 'appNodeLogic']),
  props({} as AppNodeLogicProps),
  key((props) => `${props.frameId}/${props.sceneId}/${props.nodeId}`),
  connect(({ sceneId, frameId }: DiagramLogicProps) => ({
    values: [appsModel, ['apps'], diagramLogic({ frameId, sceneId }), ['nodes', 'edges', 'selectedNodeId', 'scene']],
    actions: [diagramLogic({ frameId, sceneId }), ['selectNode']],
  })),
  actions({
    select: true,
  }),
  selectors({
    nodeId: [() => [(_, props) => props.nodeId], (nodeId): string => nodeId],
    node: [
      (s) => [s.nodes, s.nodeId],
      (nodes: DiagramNode[], nodeId: string) => nodes?.find((n) => n.id === nodeId) ?? null,
    ],
    nodeEdges: [
      (s) => [s.edges, s.nodeId],
      (edges: Edge[], nodeId): Edge[] => edges?.filter((e) => e.source === nodeId || e.target === nodeId) ?? [],
    ],
    nodeConfig: [
      (s) => [s.node],
      (node): Record<string, any> => (node && 'config' in node?.data ? node?.data.config ?? {} : {}),
    ],
    codeFields: [
      (s) => [s.nodeEdges, s.nodeId],
      (nodeEdges, nodeId) =>
        nodeEdges
          .filter(
            (edge) =>
              (edge.sourceHandle === 'fieldOutput' || edge.sourceHandle?.startsWith('code/')) &&
              nodeId == edge.target &&
              edge.targetHandle?.startsWith('fieldInput/')
          )
          .map((edge) => edge.targetHandle?.replace('fieldInput/', '') ?? ''),
    ],
    fieldInputFields: [
      (s) => [s.nodeEdges, s.nodeId],
      (nodeEdges, nodeId) =>
        nodeEdges
          .filter(
            (edge) =>
              (edge.sourceHandle === 'fieldOutput' || edge.sourceHandle?.startsWith('field/')) &&
              nodeId == edge.target &&
              edge.targetHandle?.startsWith('fieldInput/')
          )
          .map((edge) => edge.targetHandle?.replace('fieldInput/', '') ?? ''),
    ],
    fieldOutputFields: [
      (s) => [s.nodeEdges, s.nodeId],
      (nodeEdges, nodeId) =>
        nodeEdges
          .filter(
            (edge) => edge.sourceHandle?.startsWith('field/') && nodeId == edge.source && edge.targetHandle === 'prev'
          )
          .map((edge) => edge.sourceHandle?.replace('field/', '') ?? ''),
    ],
    isSelected: [(s) => [s.selectedNodeId, s.nodeId], (selectedNodeId, nodeId) => selectedNodeId === nodeId],
    sources: [
      (s) => [s.apps, s.node],
      (apps, node): Record<string, string> | null => {
        if (node && node.data && 'sources' in node.data && node.data.sources) {
          return node.data.sources
        }
        return null
      },
    ],
    sourceConfigJson: [
      (s) => [s.sources],
      (sources): [Record<string, any> | null, Error | string | null] => {
        try {
          if (sources) {
            const json = sources['config.json']
            if (json) {
              const config = JSON.parse(json)
              if (typeof config === 'object') {
                return [config, null]
              }
            }
          }
        } catch (e) {
          return [null, e instanceof Error ? e : String(e)]
        }
        return [null, null]
      },
    ],
    configJsonError: [
      (s) => [s.sourceConfigJson, s.sources],
      ([_, error]) => {
        return error === null ? null : error instanceof Error ? error.message : String(error)
      },
    ],
    app: [
      (s) => [s.apps, s.node],
      (apps, node): App | null => {
        if (
          node &&
          node.type === 'app' &&
          node.data &&
          'keyword' in node.data &&
          node.data.keyword &&
          !('sources' in node.data)
        ) {
          return apps[node.data.keyword] ?? null
        }
        return null
      },
    ],
    event: [
      (s) => [s.node],
      (node): App | null => {
        if (node && node.type === 'dispatch' && node.data && 'keyword' in node.data && node.data.keyword) {
          return events.find((e) => 'keyword' in node.data && e.name == node.data.keyword) ?? null
        }
        return null
      },
    ],
    isApp: [(s) => [s.node], (node) => node?.type === 'app'],
    isDispatch: [(s) => [s.node], (node) => node?.type === 'dispatch'],
    configJson: [
      (s) => [s.app, s.sourceConfigJson],
      (app, [config]) => {
        return config || app || null
      },
    ],
    fields: [
      (s) => [s.app, s.event, s.scene, s.configJson],
      (app, event, scene, configJson): (ConfigField | MarkdownField)[] | null => {
        if (event) {
          if (event.name === 'setSceneState') {
            return scene?.fields ?? null
          }
          return event?.fields ?? null
        }
        return app?.fields ?? configJson?.fields ?? null
      },
    ],
    name: [
      (s) => [s.app, s.event, s.configJson],
      (app, event, configJson): string => {
        return event ? `Dispatch: ${String(event?.name ?? 'Event')}` : String(app?.name ?? configJson?.name ?? 'App')
      },
    ],
    isCustomApp: [
      (s) => [s.node],
      (node) => {
        return 'sources' in (node?.data ?? {})
      },
    ],
  }),
  listeners(({ actions, values }) => ({
    select: () => {
      if (!values.isSelected) {
        actions.selectNode(values.nodeId)
      }
    },
  })),
])
