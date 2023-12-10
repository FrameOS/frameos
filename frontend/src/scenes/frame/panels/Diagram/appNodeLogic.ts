import { connect, kea, key, path, props, selectors } from 'kea'

import type { appNodeLogicType } from './appNodeLogicType'
import { diagramLogic, DiagramLogicProps } from './diagramLogic'
import { appsModel } from '../../../../models/appsModel'
import type { Node } from '@reactflow/core/dist/esm/types/nodes'
import { App } from '../../../../types'

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
      (s) => [s.sources, s.node],
      (sources, node) => {
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
          return [null, e]
        }
        return [null, null]
      },
    ],
    configJsonError: [
      (s) => [s.sourceConfigJson, s.sources],
      ([config, error]) => {
        return error === null ? null : error instanceof Error ? error.message : String(error)
      },
    ],
    app: [
      (s) => [s.apps, s.node],
      (apps, node): App | null => {
        if (node && node.data && node.data.keyword) {
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
      (s) => [s.app],
      (app) => {
        return app?.fields ?? null
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
