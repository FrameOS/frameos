import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'

import type { appNodeLogicType } from './appNodeLogicType'
import { diagramLogic, DiagramLogicProps } from './diagramLogic'
import { appsModel } from '../../../../models/appsModel'
import { App, CodeNodeData, ConfigField, DiagramNode, FrameEvent, MarkdownField } from '../../../../types'
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
    actions: [
      diagramLogic({ frameId, sceneId }),
      ['selectNode', 'updateNodeData', 'deleteApp', 'setNodes', 'setEdges'],
    ],
  })),
  actions({
    select: true,
    editCodeField: (field: string) => ({ field }),
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
      (s) => [s.app, s.event, s.scene, s.configJson, s.nodeConfig],
      (app, event, scene, configJson, nodeConfig): (ConfigField | MarkdownField)[] | null => {
        let fields: (ConfigField | MarkdownField)[] = []
        if (event) {
          if (event.name === 'setSceneState') {
            fields = scene?.fields ?? []
          } else {
            fields = event?.fields ?? []
          }
        } else {
          fields = app?.fields ?? configJson?.fields ?? []
        }

        let realFields: (ConfigField | MarkdownField)[] = []
        for (const field of fields) {
          if ('seq' in field && Array.isArray(field.seq)) {
            let seqs: [string, number[]][] = []
            for (const [name, _min, _max] of field.seq) {
              let min = typeof _min === 'number' ? _min : parseInt(nodeConfig[_min] ?? '1')
              let max = typeof _max === 'number' ? _max : parseInt(nodeConfig[_max] ?? '1')
              let numbers = []
              for (let i = min; i <= max; i++) {
                numbers.push(i)
              }
              seqs.push([name, numbers])
            }
            let existing: number[][] = []
            for (let i = 0; i < seqs.length; i++) {
              const numbers = seqs[i][1]
              const newExisting = []
              if (existing.length > 0) {
                for (const ext of existing) {
                  for (const num of numbers) {
                    newExisting.push([...ext, num])
                  }
                }
              } else {
                for (const num of numbers) {
                  newExisting.push([num])
                }
              }
              existing = newExisting
            }
            for (const values of existing) {
              let label = field.label
              for (let i = 0; i < values.length; i++) {
                label = label.replace(`{${seqs[i][0]}}`, String(values[i]))
              }
              realFields.push({
                ...field,
                label: label,
                name: `${field.name}[${values.join('][')}]`,
              })
            }
          } else {
            realFields.push(field)
          }
        }
        return realFields
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
    editCodeField: ({ field }) => {
      const newField = prompt('Rename field:', field)
      const codeFieldEdge = values.nodeEdges.find(
        (edge) => edge.sourceHandle === 'fieldOutput' && edge.targetHandle?.startsWith('codeField/')
      )
      const codeFields = (values.node?.data as CodeNodeData)?.codeFields ?? []
      if (newField) {
        actions.setEdges(
          values.edges.map((e) =>
            e.target === values.nodeId && e.targetHandle === `codeField/${field}`
              ? { ...e, targetHandle: `codeField/${newField}` }
              : e
          )
        )
        actions.updateNodeData(values.nodeId, { codeFields: codeFields.map((f) => (f === field ? newField : f)) })
      } else {
        if (codeFieldEdge?.source) {
          actions.deleteApp(codeFieldEdge.source)
        }
        actions.updateNodeData(values.nodeId, { codeFields: codeFields.filter((f) => f !== field) })
      }
    },
  })),
])
