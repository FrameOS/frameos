import { actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { v4 as uuidv4 } from 'uuid'

import equal from 'fast-deep-equal'
import type { newNodePickerLogicType } from './newNodePickerLogicType'
import {
  AppConfig,
  AppNodeData,
  CodeNodeData,
  AppConfigField,
  DiagramNode,
  MarkdownField,
  CodeArg,
  FieldType,
  fieldTypes,
  toFieldType,
} from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { appsModel } from '../../../../models/appsModel'
import { Option } from '../../../../components/Select'
import { stateFieldAccess } from '../../../../utils/fieldTypes'
import { diagramLogic } from './diagramLogic'
import Fuse from 'fuse.js'

export interface LocalFuse extends Fuse<OptionWithType> {}

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

export interface OptionWithType extends Option {
  /** type of the node we're connecting to */
  type: FieldType
  /** keyword we can use to refer to the other node, e.g. the field name */
  keyword: string
}

export function getNewFieldName(codeArgs: CodeArg[]): string {
  let newFieldName = 'arg'
  let i = 1
  while (codeArgs.map((c) => c.name).includes(newFieldName)) {
    newFieldName = `arg${i}`
    i++
  }
  return newFieldName
}

function getAppsForType(apps: Record<string, AppConfig>, returnType: string = 'image'): Record<string, AppConfig> {
  const imageApps: Record<string, AppConfig> = {}
  for (const [keyword, app] of Object.entries(apps)) {
    if (app.output && app.output.length > 0 && app.output[0].type === returnType) {
      imageApps[keyword] = app
    }
  }
  return imageApps
}

function toBaseType(type: string | FieldType): FieldType {
  if (fieldTypes.includes(type as FieldType)) {
    return type as FieldType
  }
  return 'string'
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
    selectNewNodeOption: (newNodePicker: NewNodePicker, option: OptionWithType) => ({
      newNodePicker,
      option,
    }),
    closeNewNodePicker: true,
    setSearchValue: (searchValue: string) => ({ searchValue }),
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
    searchValue: [
      '',
      {
        setSearchValue: (_, { searchValue }) => searchValue,
      },
    ],
  }),
  selectors({
    frameId: [() => [(_, props) => props.frameId], (frameId) => frameId],
    sceneId: [() => [(_, props) => props.sceneId], (sceneId) => sceneId],
    node: [
      (s) => [s.newNodePicker, s.nodesById],
      (newNodePicker, nodesById): DiagramNode | null => {
        if (!newNodePicker) {
          return null
        }
        const { nodeId } = newNodePicker
        const node = nodesById[nodeId] ?? null
        return node
      },
    ],
    newNodeHandleDataType: [
      (s) => [s.newNodePicker, s.apps, s.node],
      (newNodePicker, apps, node): FieldType | null => {
        if (!newNodePicker || !node) {
          return null
        }
        const { handleId, handleType } = newNodePicker
        // AppInputHandle
        if (handleType === 'target' && handleId.startsWith('fieldInput/')) {
          const key = handleId.split('/', 2)[1]
          if (node.type === 'app' && (node.data as AppNodeData)?.sources?.['config.json']) {
            try {
              const json = JSON.parse((node.data as AppNodeData)?.sources?.['config.json'] ?? '{}')
              const field = json.fields?.find((f: AppConfigField | MarkdownField) => 'name' in f && f.name === key)
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
        // CodeInputHandle & NewCodeInputHandle
        if (handleType === 'target' && handleId.startsWith('codeField/')) {
          const key = handleId.split('/', 2)[1]
          const codeArgs = (node.data as CodeNodeData)?.codeArgs ?? []
          const arg = codeArgs.find((arg) => arg.name === key)
          return arg?.type ? toBaseType(arg.type) : null
        }
        // CodeOutputHandle
        if (handleType === 'source' && handleId.startsWith('fieldOutput')) {
          const key = handleId.split('/', 2)[1]
          if (node.type === 'code') {
            const codeOutputs = (node.data as CodeNodeData)?.codeOutputs ?? []
            const arg = codeOutputs[0]
            return arg?.type ? toBaseType(arg.type) : null
          } else if (node.type === 'app') {
            const app = apps[(node.data as AppNodeData).keyword]
            const output = app.output?.[0]
            return output?.type ? toBaseType(output.type) : null
          }
        }
        return null
      },
    ],
    allNewNodeOptions: [
      (s) => [s.newNodePicker, s.apps, s.scene, s.newNodeHandleDataType, s.node],
      (newNodePicker, apps, scene, newNodeHandleDataType, node): OptionWithType[] => {
        if (!newNodePicker || !node) {
          return []
        }
        const { handleId, handleType } = newNodePicker
        const options: OptionWithType[] = []

        // Pulling out a field to the left of an app to specify a custom input
        if (handleType === 'target' && (handleId.startsWith('fieldInput/') || handleId.startsWith('codeField/'))) {
          const key = handleId.split('/', 2)[1]
          options.push({ label: 'Code', value: 'code', type: newNodeHandleDataType ?? 'string', keyword: key })
          if (newNodeHandleDataType) {
            const appsForType = getAppsForType(apps, newNodeHandleDataType)
            for (const [keyword, app] of Object.entries(appsForType)) {
              options.push({
                label: `App: ${app.name}`,
                value: `app/${keyword}`,
                type: newNodeHandleDataType,
                keyword: key,
              })
            }
            if (newNodeHandleDataType === 'image') {
              options.push({
                label: "Render context's image",
                value: 'code/context.image',
                type: newNodeHandleDataType,
                keyword: key,
              })
            }
            for (const field of (scene?.fields ?? []).filter(
              (f) => 'type' in f && typesMatch(f.type, newNodeHandleDataType)
            )) {
              options.push({
                label: `State: ${field.label}`,
                value: `state/${field.name}`,
                type: newNodeHandleDataType,
                keyword: field.name,
              })
            }
          } else if (handleId === 'codeField/+') {
            for (const [keyword, app] of Object.entries(apps)) {
              if (app.output && app.output.length > 0) {
                options.push({
                  label: `App: ${app.name}`,
                  value: `app/${keyword}`,
                  type: app.output[0].type,
                  keyword: key,
                })
              }
            }
            for (const field of scene?.fields ?? []) {
              options.push({
                label: `State: ${field.label}`,
                value: `state/${field.name}`,
                type: toFieldType(field.type),
                keyword: field.name,
              })
            }
          } else {
            options.push({ label: 'Error: unable to determine data type', value: 'app', type: 'string', keyword: key })
          }
        } else if (
          (handleType === 'source' && (handleId === 'next' || handleId.startsWith('field/'))) ||
          (handleType === 'target' && handleId === 'prev')
        ) {
          for (const [keyword, app] of Object.entries(apps)) {
            if (app.category !== 'legacy' && (!app.output || app.output.length == 0 || app.category === 'render')) {
              options.push({
                label: `${app.category ?? 'app'}: ${app.name}`,
                value: `app/${keyword}`,
                type: toFieldType(app.output?.[0].type ?? 'string'),
                keyword,
              })
            }
          }
        } else if (handleType === 'source' && handleId === 'fieldOutput') {
          let keyword = 'output'
          if (node.type === 'code') {
            keyword = (node.data as CodeNodeData)?.codeOutputs?.[0].name || keyword
          } else if (node.type === 'app') {
            const appKeyword = (node.data as AppNodeData)?.keyword || keyword
            const app = apps[appKeyword]
            keyword = app.output?.[0].name || keyword
          }
          options.push({
            label: 'Code',
            value: 'code',
            type: newNodeHandleDataType ?? 'string',
            keyword: keyword,
          })
          // TODO: show all apps that can take this field type as input
        } else {
          options.push({
            label: `handleId: ${handleId}, handleType: ${handleType}`,
            value: 'app',
            type: 'string',
            keyword: 'error',
          })
        }
        return options
      },
      { resultEqualityCheck: equal },
    ],
    sortedNewNodeOptions: [
      (s) => [s.allNewNodeOptions],
      (allNewNodeOptions): OptionWithType[] => {
        const priority: Record<string, OptionWithType[]> = { render: [], logic: [], legacy: [], other: [] }
        for (const option of allNewNodeOptions) {
          const type = option.label.split(':')[0]
          if (priority[type]) {
            priority[type].push(option)
          } else {
            priority['other'].push(option)
          }
        }
        return [...priority['render'], ...priority['logic'], ...priority['legacy'], ...priority['other']]
      },
    ],
    fuse: [
      (s) => [s.sortedNewNodeOptions],
      (sortedNewNodeOptions): LocalFuse => {
        return new Fuse(sortedNewNodeOptions, {
          keys: ['label', 'value'],
          threshold: 0.3,
          shouldSort: false,
        })
      },
    ],
    newNodeOptions: [
      (s) => [s.sortedNewNodeOptions, s.fuse, s.searchValue],
      (sortedNewNodeOptions, fuse, searchValue): OptionWithType[] => {
        return searchValue ? fuse.search(searchValue).map((result) => result.item) : sortedNewNodeOptions
      },
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
    selectNewNodeOption: ({
      newNodePicker: { diagramX, diagramY, nodeId, handleId, handleType },
      option: { label, value, type, keyword },
    }) => {
      const newNode: DiagramNode = {
        id: uuidv4(),
        position: { x: diagramX, y: diagramY },
        data: {} as any,
      }
      let newNodeOutputHandle = 'fieldOutput'

      if (handleType === 'source' && (handleId === 'next' || handleId.startsWith('field/'))) {
        newNodeOutputHandle = 'prev'
      }
      if (handleType === 'target' && handleId === 'prev') {
        newNodeOutputHandle = 'next'
      }
      if (handleId === 'fieldOutput') {
        newNodeOutputHandle = `codeField/${keyword}`
      }

      if (value === 'code' || value.startsWith('code/')) {
        newNode.position.x -= 20
        newNode.position.y -= 120
        newNode.type = 'code'
        newNode.style = {
          width: 300,
          height: 119,
        }
        const codeArgs = (values.nodesById[nodeId]?.data as CodeNodeData)?.codeArgs ?? []

        newNode.data = {
          code: value.startsWith('code/') ? value.substring(5) : '',
          codeArgs: [],
          codeOutputs: [],
        }

        if (handleId === 'fieldOutput') {
          newNode.data.codeArgs = [
            {
              name: keyword,
              type: type ?? values.newNodeHandleDataType ?? 'string',
            },
          ]
        } else {
          newNode.data.codeOutputs = [
            {
              name: keyword === '+' ? getNewFieldName(codeArgs) : keyword,
              type: type ?? values.newNodeHandleDataType ?? 'string',
            },
          ]
        }
      } else if (value.startsWith('state/')) {
        newNode.position.x -= 20
        newNode.position.y -= 20
        newNode.type = 'state'
        newNode.data = {
          keyword: value.startsWith('state/') ? value.substring(6) : '',
        }
      } else if (value.startsWith('app/')) {
        const appKeyword = value.substring(4)
        newNode.type = 'app'
        newNode.data = { keyword: appKeyword, config: {} }
        if (newNodeOutputHandle === 'prev') {
          newNode.position.x -= 20
          newNode.position.y -= 20
        } else if (newNodeOutputHandle === 'next') {
          newNode.position.x -= 270
          newNode.position.y -= 20
        } else {
          newNode.position.x -= 20
          newNode.position.y -= 100
          const app = values.apps[appKeyword]
          // Note: we place apps at a rough estimate above the node they're connected to. should be improved
          for (const field of app.fields ?? []) {
            newNode.position.y -= 30 + ('type' in field && field.type === 'text' ? (field.rows ?? 3) * 20 : 0)
          }
          if (app.cache) {
            ;(newNode.data as AppNodeData).cache = { ...app.cache }
          }
        }
      } else {
        return
      }

      if (handleId === 'codeField/+') {
        const codeArgs = (values.nodes.find((node) => node.id === nodeId)?.data as CodeNodeData)?.codeArgs ?? []
        let newArg = { name: keyword || getNewFieldName(codeArgs), type: type ?? 'string' } satisfies CodeArg
        actions.setNodes([
          ...values.nodes.map((node) =>
            node.id === nodeId ? { ...node, data: { ...node.data, codeArgs: [...codeArgs, newArg] } } : node
          ),
          newNode,
        ])
        window.setTimeout(() => {
          actions.addEdge({
            id: uuidv4(),
            target: nodeId,
            targetHandle: `codeField/${newArg.name}`,
            source: newNode.id,
            sourceHandle: newNodeOutputHandle,
          })
          window.setTimeout(() => {
            props.updateNodeInternals?.(nodeId)
            props.updateNodeInternals?.(newNode.id)
          }, 200)
        }, 200)
      } else {
        actions.setNodes([...values.nodes, newNode])
        window.setTimeout(() => {
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
        }, 200)
      }
      actions.setSearchValue('')
    },
  })),
])
