import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { v4 as uuidv4 } from 'uuid'

import equal from 'fast-deep-equal'
import type { newNodePickerLogicType } from './newNodePickerLogicType'
import { App, AppNodeData, CodeNodeData, ConfigField, DiagramNode, MarkdownField } from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { appsModel } from '../../../../models/appsModel'
import { Option } from '../../../../components/Select'
import { stateFieldAccess } from '../../../../utils/fieldTypes'
import { diagramLogic } from './diagramLogic'

export interface NewNodePickerLogicProps {
  frameId: number
  sceneId: string
  updateNodeInternals?: (nodeId: string) => void
}

export interface NewNodePicker {
  screenX: number
  screenY: number
  diagramX: number
  diagramY: number
  handleId: string
  handleType: string
  nodeId: string
}

export function getNewField(codeFields: string[]): string {
  let newField = 'arg'
  let i = 1
  while (codeFields.includes(newField)) {
    newField = `arg${i}`
    i++
  }
  return newField
}

function getAppsForType(apps: Record<string, App>, returnType: string = 'image'): Record<string, App> {
  const imageApps: Record<string, App> = {}
  for (const [keyword, app] of Object.entries(apps)) {
    if (app.output && app.output.length > 0 && app.output[0].type === returnType) {
      imageApps[keyword] = app
    }
  }
  return imageApps
}

function toBaseType(type: string): string {
  if (['string', 'select', 'text'].includes(type)) {
    return 'string'
  }
  return type
}

function typesMatch(type1: string, type2: string): boolean {
  return toBaseType(type1) === toBaseType(type2)
}

export const newNodePickerLogic = kea<newNodePickerLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'Diagram', 'newNodePickerLogic']),
  props({} as NewNodePickerLogicProps),
  key((props) => `${props.frameId}/${props.sceneId}`),
  connect(({ frameId, sceneId }: NewNodePickerLogicProps) => ({
    values: [
      frameLogic({ frameId }),
      ['frame', 'frameForm'],
      diagramLogic({ frameId, sceneId }),
      ['nodesById', 'nodes', 'scene'],
      appsModel,
      ['apps'],
    ],
    actions: [
      frameLogic({ frameId }),
      ['setFrameFormValues', 'applyTemplate'],
      diagramLogic({ frameId, sceneId }),
      ['setNodes', 'addEdge'],
    ],
  })),
  actions({
    openNewNodePicker: (
      screenX: number,
      screenY: number,
      diagramX: number,
      diagramY: number,
      nodeId: string,
      handleId: string,
      handleType: string
    ) => ({
      screenX,
      screenY,
      diagramX,
      diagramY,
      nodeId,
      handleId,
      handleType,
    }),
    selectNewNodeOption: (newNodePicker: NewNodePicker, value: string, label: string) => ({
      newNodePicker,
      value,
      label,
    }),
    closeNewNodePicker: true,
  }),
  reducers({
    newNodePicker: [
      null as NewNodePicker | null,
      {
        openNewNodePicker: (_, { screenX, screenY, diagramX, diagramY, handleId, handleType, nodeId }) => ({
          screenX,
          screenY,
          diagramX,
          diagramY,
          handleId,
          handleType,
          nodeId,
        }),
        closeNewNodePicker: () => null,
      },
    ],
    newNodePickerIndex: [
      0,
      {
        openNewNodePicker: (state) => state + 1,
      },
    ],
  }),
  selectors({
    frameId: [() => [(_, props) => props.frameId], (frameId) => frameId],
    sceneId: [() => [(_, props) => props.sceneId], (sceneId) => sceneId],
    newNodeHandleDataType: [
      (s) => [s.newNodePicker, s.nodesById, s.apps, s.scene],
      (newNodePicker, nodesById, apps, scene): string | null => {
        if (!newNodePicker) {
          return null
        }
        const { handleId, handleType, nodeId } = newNodePicker
        const [node] = nodesById[nodeId] ?? []
        if (!node) {
          return null
        }
        if (handleType === 'target' && handleId.startsWith('fieldInput/')) {
          const key = handleId.split('/', 2)[1]
          if (node.type === 'app' && (node.data as AppNodeData)?.sources?.['config.json']) {
            try {
              const json = JSON.parse((node.data as AppNodeData)?.sources?.['config.json'] ?? '{}')
              const field = json.fields?.find((f: ConfigField | MarkdownField) => 'name' in f && f.name === key)
              const type = field && 'type' in field ? field.type || null : null
              return type ? toBaseType(type) : null
            } catch (e) {
              console.error(e)
            }
          } else if (node.type === 'app' && node.data && 'keyword' in node.data && apps[node.data?.keyword]) {
            const app = apps[node.data.keyword]
            const field = app.fields?.find((f) => 'name' in f && f.name === key)
            const type = field && 'type' in field ? field.type || null : null
            return type ? toBaseType(type) : null
          }
        }
        if (handleType === 'target' && handleId.startsWith('codeField/')) {
          console.error('Must add type support to code field arguments!')
        }
        return null
      },
    ],
    newNodeOptions: [
      (s) => [s.newNodePicker, s.nodesById, s.apps, s.scene, s.newNodeHandleDataType],
      (newNodePicker, nodesById, apps, scene, newNodeHandleDataType): Option[] => {
        if (!newNodePicker) {
          return []
        }
        const { handleId, handleType } = newNodePicker
        const options: Option[] = []

        // Pulling out a field to the left of an app to specify a custom input
        if (handleType === 'target' && (handleId.startsWith('fieldInput/') || handleId.startsWith('codeField/'))) {
          const key = handleId.split('/', 2)[1]

          options.push({ label: 'Code', value: 'code' })
          if (newNodeHandleDataType) {
            const imageApps = getAppsForType(apps, newNodeHandleDataType)
            for (const [keyword, app] of Object.entries(imageApps)) {
              options.push({ label: `App: ${app.name}`, value: `app/${keyword}` })
            }
            for (const field of (scene?.fields ?? []).filter(
              (f) => 'type' in f && typesMatch(f.type, newNodeHandleDataType)
            )) {
              options.push({
                label: `State: ${field.label}`,
                value: `code/${stateFieldAccess(field)}`,
              })
            }
          } else if (handleId === 'codeField/+') {
            for (const [keyword, app] of Object.entries(apps)) {
              if (app.output && app.output.length > 0) {
                options.push({ label: `App: ${app.name}`, value: `app/${keyword}` })
              }
            }
            for (const field of scene?.fields ?? []) {
              options.push({
                label: `State: ${field.label}`,
                value: `code/${stateFieldAccess(field)}`,
              })
            }
          } else {
            options.push({ label: 'Error: unknown new node data type', value: 'app' })
          }
        } else if (
          (handleType === 'source' && (handleId === 'next' || handleId.startsWith('field/'))) ||
          (handleType === 'target' && handleId === 'prev')
        ) {
          for (const [keyword, app] of Object.entries(apps)) {
            if (!app.output || app.output.length == 0) {
              options.push({ label: `${app.category ?? 'app'}: ${app.name}`, value: `app/${keyword}` })
            }
          }
        } else {
          options.push({ label: `handleId: ${handleId}, handleType: ${handleType}`, value: 'app' })
        }

        const priority = ['render', 'logic', 'legacy']

        options.sort((a, b) => {
          const a1 = a.label.split(':')[0]
          const b1 = b.label.split(':')[0]

          const aPriority = priority.indexOf(a1)
          const bPriority = priority.indexOf(b1)

          if (aPriority !== -1 && bPriority === -1) return -1
          if (aPriority === -1 && bPriority !== -1) return 1
          if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority

          return a.label.localeCompare(b.label)
        })

        return options
      },
      { resultEqualityCheck: equal },
    ],
    targetFieldName: [
      (s) => [s.newNodePicker],
      (newNodePicker): string | null => {
        if (!newNodePicker) {
          return null
        }
        const { handleId, handleType } = newNodePicker
        if (handleType === 'target' && handleId.startsWith('fieldInput/')) {
          return handleId.split('/')[1]
        }
        return null
      },
    ],
    searchPlaceholder: [
      (s) => [s.newNodePicker, s.targetFieldName, s.newNodeHandleDataType],
      (newNodePicker, targetFieldName, newNodeHandleDataType): string => {
        if (!newNodePicker) {
          return 'New node'
        }
        const { handleId, handleType } = newNodePicker
        if (handleType === 'source' && (handleId === 'next' || handleId.startsWith('field/'))) {
          return 'Select next node'
        }
        if (handleType === 'target' && handleId === 'prev') {
          return 'Select previous node'
        }
        return `${targetFieldName ?? 'select'}${newNodeHandleDataType ? ` (${newNodeHandleDataType})` : ''}`
      },
    ],
    placement: [
      (s) => [s.newNodePicker],
      (newNodePicker): string => {
        if (!newNodePicker) {
          return 'New node'
        }
        const { handleId, handleType } = newNodePicker
        if (handleType === 'source') {
          return 'bottom-start'
        }
        return 'bottom-start'
      },
    ],
  }),
  listeners(({ actions, values, props }) => ({
    selectNewNodeOption: ({ newNodePicker: { diagramX, diagramY, nodeId, handleId, handleType }, label, value }) => {
      const newNode: DiagramNode = {
        id: uuidv4(),
        position: { x: diagramX, y: diagramY },
        data: {} as any,
        style: {
          width: 300,
          height: 130,
        },
      }
      let newNodeOutputHandle = 'fieldOutput'

      if (handleType === 'source' && (handleId === 'next' || handleId.startsWith('field/'))) {
        newNodeOutputHandle = 'prev'
      }
      if (handleType === 'target' && handleId === 'prev') {
        newNodeOutputHandle = 'next'
      }

      if (value === 'code' || value.startsWith('code/')) {
        newNode.position.x -= 20
        newNode.position.y -= 120
        newNode.type = 'code'
        newNode.data = { code: value.startsWith('code/') ? value.substring(5) : '', codeFields: [] }
      } else if (value.startsWith('app/')) {
        const keyword = value.substring(4)
        if (newNodeOutputHandle === 'prev') {
          newNode.position.x -= 20
          newNode.position.y -= 20
        } else if (newNodeOutputHandle === 'next') {
          newNode.position.x -= 270
          newNode.position.y -= 20
        } else {
          newNode.position.x -= 20
          newNode.position.y -= 100
          const app = values.apps[keyword]
          for (const field of app.fields ?? []) {
            newNode.position.y -= 30 + ('type' in field && field.type === 'text' ? (field.rows ?? 3) * 20 : 0)
          }
        }
        newNode.type = 'app'
        newNode.data = { keyword, config: {} }
      } else {
        return
      }

      if (handleId === 'codeField/+') {
        const codeFields = (values.nodes.find((node) => node.id === nodeId)?.data as CodeNodeData)?.codeFields ?? []
        let newField = getNewField(codeFields)
        actions.setNodes([
          ...values.nodes.map((node) =>
            node.id === nodeId ? { ...node, data: { ...node.data, codeFields: [...codeFields, newField] } } : node
          ),
          newNode,
        ])
        window.requestAnimationFrame(() => {
          actions.addEdge({
            id: uuidv4(),
            target: nodeId,
            targetHandle: `codeField/${newField}`,
            source: newNode.id,
            sourceHandle: newNodeOutputHandle,
          })
          window.setTimeout(() => {
            props.updateNodeInternals?.(nodeId)
            props.updateNodeInternals?.(newNode.id)
          }, 200)
        })
      } else {
        actions.setNodes([...values.nodes, newNode])
        window.requestAnimationFrame(() => {
          if (handleType === 'source') {
            actions.addEdge({
              id: uuidv4(),
              source: nodeId,
              sourceHandle: handleId,
              target: newNode.id,
              targetHandle: newNodeOutputHandle,
            })
          } else {
            actions.addEdge({
              id: uuidv4(),
              target: nodeId,
              targetHandle: handleId,
              source: newNode.id,
              sourceHandle: newNodeOutputHandle,
            })
          }
          window.setTimeout(() => {
            props.updateNodeInternals?.(nodeId)
            props.updateNodeInternals?.(newNode.id)
          }, 200)
        })
      }
    },
  })),
])
