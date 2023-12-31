import { connect, kea, key, path, props, selectors } from 'kea'

import type { appNodeLogicType } from './appNodeLogicType'
import { diagramLogic, DiagramLogicProps } from './diagramLogic'
import { appsModel } from '../../../../models/appsModel'
import type { Node } from '@reactflow/core/dist/esm/types/nodes'
import { App, ConfigField, MarkdownField } from '../../../../types'
import type { Edge } from '@reactflow/core/dist/esm/types/edges'

export interface AppNodeLogicProps extends DiagramLogicProps {
  nodeId: string
}

export const appNodeLogic = kea<appNodeLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Diagram', 'appNodeLogic']),
  props({} as AppNodeLogicProps),
  key((props) => `${props.frameId}/${props.sceneId}/${props.nodeId}`),
  connect(({ sceneId, frameId }: DiagramLogicProps) => ({
    values: [appsModel, ['apps'], diagramLogic({ frameId, sceneId }), ['nodes', 'edges', 'selectedNodeId']],
  })),
  selectors({
    nodeId: [() => [(_, props) => props.nodeId], (nodeId): string => nodeId],
    node: [(s) => [s.nodes, s.nodeId], (nodes: Node[], nodeId: string) => nodes?.find((n) => n.id === nodeId) ?? null],
    nodeEdges: [
      (s) => [s.edges, s.nodeId],
      (edges: Edge[], nodeId): Edge[] => edges?.filter((e) => e.source === nodeId || e.target === nodeId) ?? [],
    ],
    codeFields: [
      (s) => [s.nodeEdges],
      (nodeEdges) =>
        nodeEdges
          .filter((edge) => edge.sourceHandle === 'fieldOutput' && edge.targetHandle?.startsWith('fieldInput/'))
          .map((edge) => edge.targetHandle?.replace('fieldInput/', '') ?? ''),
    ],
    isSelected: [(s) => [s.selectedNodeId, s.nodeId], (selectedNodeId, nodeId) => selectedNodeId === nodeId],
    sources: [
      (s) => [s.apps, s.node],
      (apps, node): Record<string, string> | null => {
        if (node && node.data && node.data.sources) {
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
        if (node && node.data && node.data.keyword && !node.data.sources) {
          return apps[node.data.keyword] ?? null
        }
        return null
      },
    ],
    configJson: [
      (s) => [s.app, s.sourceConfigJson],
      (app, [config]) => {
        return config || app || null
      },
    ],
    appFields: [
      (s) => [s.app, s.configJson],
      (app, configJson): (ConfigField | MarkdownField)[] | null => {
        return app?.fields ?? configJson?.fields ?? null
      },
    ],
    appName: [
      (s) => [s.app, s.configJson],
      (app, configJson): string => {
        return String(app?.name ?? configJson?.name ?? 'App')
      },
    ],
    isCustomApp: [
      (s) => [s.node],
      (node) => {
        return !!node?.data?.sources
      },
    ],
  }),
])
