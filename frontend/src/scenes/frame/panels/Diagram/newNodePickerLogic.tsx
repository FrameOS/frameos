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
  SceneNodeData,
  EventNodeData,
  FrameEvent,
  DispatchNodeData,
  FrameType,
} from '../../../../types'
import { frameLogic } from '../../frameLogic'
import { appsModel } from '../../../../models/appsModel'
import { Option } from '../../../../components/Select'
import { diagramLogic } from './diagramLogic'
import Fuse from 'fuse.js'
import { Edge } from 'reactflow'
import { sceneStateLogic } from '../SceneState/sceneStateLogic'
import _events from '../../../../../schema/events.json'
import {
  appLabel,
  installSceneAppForKeyword,
  isJavaScriptCatalogApp,
  javascriptCatalogAppKeywords,
  javascriptCatalogAppLabel,
} from '../../../../utils/sceneApps'
import { appCompatibilityForFrame } from '../../../../utils/embeddedCompatibility'

export interface LocalFuse extends Fuse<OptionWithType> {}

export const CANVAS_NODE_ID = '__canvas__'
const INLINE_CODE_OPTION_LABEL = 'Code: new inline node'

const events: FrameEvent[] = _events as any
const dispatchableEvents: FrameEvent[] = events.filter((event) => event.canDispatch)

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
  disabledReason?: string
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

function simplifyType(type: string): FieldType {
  if (type === 'select' || type === 'text') {
    return 'string'
  }
  return type as FieldType
}

function getAppsForType(apps: Record<string, AppConfig>, returnType: string = 'image'): Record<string, AppConfig> {
  const imageApps: Record<string, AppConfig> = {}
  for (const [keyword, app] of Object.entries(apps)) {
    if (app.output && app.output.length > 0 && simplifyType(app.output[0].type) === simplifyType(returnType)) {
      imageApps[keyword] = app
    }
  }
  return imageApps
}

function isRunnableApp(app: AppConfig): boolean {
  return app.category !== 'legacy' && (!app.output || app.output.length === 0 || app.category === 'render')
}

function addJavaScriptCatalogAppOptions(
  options: OptionWithType[],
  apps: Record<string, AppConfig>,
  mode: FrameType['mode'] | undefined | null,
  frame: Partial<FrameType> | null | undefined,
  filter?: (app: AppConfig) => boolean,
  optionKeyword?: string
): void {
  for (const keyword of javascriptCatalogAppKeywords) {
    const app = apps[keyword]
    if (!app || (filter && !filter(app))) {
      continue
    }
    const compatibility = appCompatibilityForFrame(mode, keyword, app, undefined, frame)
    options.push({
      label: javascriptCatalogAppLabel(keyword, app),
      value: `app/${keyword}`,
      type: toFieldType(app.output?.[0].type ?? 'string'),
      keyword: optionKeyword ?? keyword,
      disabledReason: compatibility.reason,
    })
  }
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
      ['frame', 'frameForm', 'scenes'],
      diagramLogic({ frameId, sceneId }),
      ['nodesById', 'nodes', 'edges', 'scene', 'effectiveApps', 'sceneApps'],
      appsModel,
      ['apps'],
    ],
    actions: [
      frameLogic({ frameId }),
      ['setFrameFormValues', 'applyTemplate'],
      diagramLogic({ frameId, sceneId }),
      ['setNodes', 'setEdges', 'addEdge', 'setCursorPosition', 'pasteFromClipboard', 'setSceneApps'],
      sceneStateLogic({ frameId, sceneId }),
      ['createField'],
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
      (s) => [s.newNodePicker, s.effectiveApps, s.node, s.scenes],
      (newNodePicker, effectiveApps, node, scenes): FieldType | null => {
        if (!newNodePicker || newNodePicker.nodeId === CANVAS_NODE_ID) {
          return null
        }
        if (!node) {
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
          } else if (node.type === 'app' && node.data && 'keyword' in node.data && effectiveApps[node.data?.keyword]) {
            const app = effectiveApps[node.data.keyword]
            const field = app.fields?.find((f) => 'name' in f && f.name === key)
            const type = field && 'type' in field ? field.type || null : null
            return type ? toBaseType(type) : null
          } else if (node.type === 'scene') {
            const scene = scenes.find(({ id }) => id === (node.data as SceneNodeData).keyword)
            const field = scene?.fields?.find((f) => 'name' in f && f.name === key)
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
            const app = effectiveApps[(node.data as AppNodeData).keyword]
            const output = app.output?.[0]
            return output?.type ? toBaseType(output.type) : null
          }
        }
        return null
      },
    ],
    allNewNodeOptions: [
      (s) => [s.newNodePicker, s.effectiveApps, s.scene, s.scenes, s.newNodeHandleDataType, s.node, s.frameForm],
      (newNodePicker, effectiveApps, scene, scenes, newNodeHandleDataType, node, frameForm): OptionWithType[] => {
        if (!newNodePicker) {
          return []
        }
        const mode = frameForm.mode
        const { handleId, handleType, nodeId } = newNodePicker
        const options: OptionWithType[] = []

        if (nodeId === CANVAS_NODE_ID) {
          options.push({
            label: 'Paste from clipboard',
            value: 'clipboard/paste',
            type: 'string',
            keyword: 'clipboard',
          })
          options.push({ label: INLINE_CODE_OPTION_LABEL, value: 'code', type: 'string', keyword: 'code' })
          addJavaScriptCatalogAppOptions(options, effectiveApps, mode, frameForm)
          for (const event of dispatchableEvents) {
            options.push({
              label: `dispatch: ${event.name}`,
              value: `dispatch/${event.name}`,
              type: 'string',
              keyword: event.name,
            })
          }
          for (const event of events) {
            options.push({
              label: `event: ${event.name}`,
              value: `event/${event.name}`,
              type: 'string',
              keyword: event.name,
            })
          }
          for (const [keyword, app] of Object.entries(effectiveApps)) {
            if (isJavaScriptCatalogApp(keyword)) {
              continue
            }
            if (isRunnableApp(app)) {
              const compatibility = appCompatibilityForFrame(mode, keyword, app, undefined, frameForm)
              options.push({
                label: appLabel(app, app.category ?? 'app'),
                value: `app/${keyword}`,
                type: toFieldType(app.output?.[0].type ?? 'string'),
                keyword,
                disabledReason: compatibility.reason,
              })
            }
          }
          for (const { id, name } of scenes) {
            options.push({ label: `scene: ${name}`, value: `scene/${id}`, type: 'scene', keyword: id })
          }
          return options
        }

        if (!node) {
          return []
        }

        // Pulling out a field (e.g. "font size") to the left of an app to specify a custom input
        if (handleType === 'target' && (handleId.startsWith('fieldInput/') || handleId.startsWith('codeField/'))) {
          const key = handleId.split('/', 2)[1]
          options.push({
            label: INLINE_CODE_OPTION_LABEL,
            value: 'code',
            type: newNodeHandleDataType ?? 'string',
            keyword: key,
          })
          options.push({
            label: 'New state field',
            value: 'state',
            type: newNodeHandleDataType ?? 'string',
            keyword: key,
          })
          if (newNodeHandleDataType) {
            const appsForType = getAppsForType(effectiveApps, newNodeHandleDataType)
            addJavaScriptCatalogAppOptions(options, appsForType, mode, frameForm, undefined, key)
            for (const [keyword, app] of Object.entries(appsForType)) {
              if (isJavaScriptCatalogApp(keyword)) {
                continue
              }
              const compatibility = appCompatibilityForFrame(mode, keyword, app, undefined, frameForm)
              options.push({
                label: appLabel(app, 'App'),
                value: `app/${keyword}`,
                type: newNodeHandleDataType,
                keyword: key,
                disabledReason: compatibility.reason,
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
            addJavaScriptCatalogAppOptions(
              options,
              effectiveApps,
              mode,
              frameForm,
              (app) => !!app.output && app.output.length > 0,
              key
            )
            for (const [keyword, app] of Object.entries(effectiveApps)) {
              if (isJavaScriptCatalogApp(keyword)) {
                continue
              }
              if (app.output && app.output.length > 0) {
                const compatibility = appCompatibilityForFrame(mode, keyword, app, undefined, frameForm)
                options.push({
                  label: appLabel(app, 'App'),
                  value: `app/${keyword}`,
                  type: app.output[0].type,
                  keyword: key,
                  disabledReason: compatibility.reason,
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
          // Next/Prev App/Event node (e.g. "next" after the "render" event)
          (handleType === 'source' && (handleId === 'next' || handleId.startsWith('field/'))) ||
          (handleType === 'target' && handleId === 'prev')
        ) {
          addJavaScriptCatalogAppOptions(options, effectiveApps, mode, frameForm, isRunnableApp)
          for (const [keyword, app] of Object.entries(effectiveApps)) {
            if (isJavaScriptCatalogApp(keyword)) {
              continue
            }
            if (isRunnableApp(app)) {
              const compatibility = appCompatibilityForFrame(mode, keyword, app, undefined, frameForm)
              options.push({
                label: appLabel(app, app.category ?? 'app'),
                value: `app/${keyword}`,
                type: toFieldType(app.output?.[0].type ?? 'string'),
                keyword,
                disabledReason: compatibility.reason,
              })
            }
          }
          for (const event of dispatchableEvents) {
            options.push({
              label: `dispatch: ${event.name}`,
              value: `dispatch/${event.name}`,
              type: 'string',
              keyword: event.name,
            })
          }
          for (const { id, name } of scenes) {
            options.push({
              label: `scene: ${name}`,
              value: `scene/${id}`,
              type: 'scene',
              keyword: id,
            })
          }
        } else if (handleType === 'source' && handleId === 'fieldOutput') {
          let keyword = 'output'
          if (node.type === 'code') {
            keyword = (node.data as CodeNodeData)?.codeOutputs?.[0].name || keyword
          } else if (node.type === 'app') {
            const appKeyword = (node.data as AppNodeData)?.keyword || keyword
            const app = effectiveApps[appKeyword]
            keyword = app.output?.[0].name || keyword
          }
          options.push({
            label: INLINE_CODE_OPTION_LABEL,
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
        const priority: Record<string, OptionWithType[]> = {
          special: [],
          code: [],
          dispatch: [],
          render: [],
          logic: [],
          legacy: [],
          other: [],
        }
        for (const option of allNewNodeOptions) {
          if (option.label === 'Paste from clipboard' || option.value === 'code') {
            priority['special'].push(option)
            continue
          }
          const type = option.label.split(':')[0].toLowerCase()
          if (priority[type]) {
            priority[type].push(option)
          } else {
            priority['other'].push(option)
          }
        }
        return [
          ...priority['special'],
          ...priority['code'],
          ...priority['render'],
          ...priority['logic'],
          ...priority['dispatch'],
          ...priority['legacy'],
          ...priority['other'],
        ]
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
        const { handleId, handleType, nodeId } = newNodePicker
        if (handleType === 'canvas' || nodeId === CANVAS_NODE_ID) {
          return 'Select next node'
        }
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
    selectNewNodeOption: async ({
      newNodePicker: { diagramX, diagramY, nodeId, handleId, handleType },
      option: { value, type, keyword, disabledReason },
    }) => {
      if (disabledReason) {
        return
      }

      if (value === 'clipboard/paste') {
        actions.setCursorPosition({ x: diagramX, y: diagramY })
        actions.pasteFromClipboard()
        actions.setSearchValue('')
        return
      }

      let currentSceneApps = values.sceneApps
      const ensureAppInScene = async (appKeyword: string): Promise<{ keyword: string; app: AppConfig } | null> => {
        let app = values.effectiveApps[appKeyword] ?? values.apps[appKeyword]
        if (!app) {
          return null
        }
        const installed = await installSceneAppForKeyword(currentSceneApps, appKeyword, app)
        const nextSceneApps = installed.sceneApps
        if (nextSceneApps !== currentSceneApps) {
          currentSceneApps = nextSceneApps
          actions.setSceneApps(nextSceneApps, true)
        }
        return installed.app ? { keyword: installed.keyword, app: installed.app } : { keyword: appKeyword, app }
      }

      if (nodeId === CANVAS_NODE_ID) {
        const newNode: DiagramNode = {
          id: uuidv4(),
          position: { x: diagramX, y: diagramY },
          data: {} as any,
        }

        if (value === 'code') {
          newNode.type = 'code'
          newNode.style = { width: 300, height: 119 }
          newNode.data = { code: '', codeArgs: [], codeOutputs: [] } satisfies CodeNodeData
        } else if (value.startsWith('dispatch/')) {
          const eventKeyword = value.substring(9)
          newNode.type = 'dispatch'
          newNode.data = { keyword: eventKeyword, config: {} } satisfies DispatchNodeData
        } else if (value.startsWith('app/')) {
          const appKeyword = value.substring(4)
          const installed = await ensureAppInScene(appKeyword)
          if (!installed) {
            actions.setSearchValue('')
            return
          }
          const { keyword: installedKeyword, app } = installed
          newNode.type = 'app'
          const appData: AppNodeData = { keyword: installedKeyword, config: {} }
          if (app?.cache) {
            appData.cache = { ...app.cache }
          }
          newNode.data = appData
        } else if (value.startsWith('scene/')) {
          const sceneKeyword = value.substring(6)
          newNode.type = 'scene'
          newNode.data = { keyword: sceneKeyword, config: {} } satisfies SceneNodeData
        } else if (value.startsWith('event/')) {
          const eventKeyword = value.substring(6)
          newNode.type = 'event'
          newNode.data = { keyword: eventKeyword } satisfies EventNodeData
        } else {
          actions.setSearchValue('')
          return
        }

        actions.setNodes([...values.nodes, newNode])
        window.setTimeout(() => {
          props.updateNodeInternals?.(newNode.id)
        }, 200)
        actions.setSearchValue('')
        return
      }

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
          newNode.data.codeOutputs = [
            {
              name: keyword,
              type: type ?? values.newNodeHandleDataType ?? 'string',
            },
          ]
        } else {
          const existingEdge = values.edges.find((edge) => edge.target === nodeId && edge.targetHandle === handleId)
          if (existingEdge) {
            const existingNode = values.nodesById[existingEdge.source]
            if (existingNode?.type === 'code') {
              newNode.data.codeArgs = [
                {
                  name: keyword,
                  type: (existingNode.data as CodeNodeData)?.codeOutputs?.[0].type ?? 'string',
                },
              ]
            } else {
              newNode.data.codeArgs = [
                {
                  name: keyword,
                  type: type ?? values.newNodeHandleDataType ?? 'string',
                },
              ]
            }
          }
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
      } else if (value === 'state') {
        newNode.position.x -= 20
        newNode.position.y -= 20
        newNode.type = 'state'
        newNode.data = {
          keyword: keyword,
        }
      } else if (value.startsWith('scene/')) {
        const sceneId = value.substring(6)
        newNode.type = 'scene'
        newNode.data = { keyword: sceneId, config: {} }
        if (newNodeOutputHandle === 'next') {
          newNode.position.x -= 270
          newNode.position.y -= 20
        } else {
          newNode.position.x -= 20
          newNode.position.y -= 20
        }
      } else if (value.startsWith('app/')) {
        const appKeyword = value.substring(4)
        const installed = await ensureAppInScene(appKeyword)
        if (!installed) {
          return
        }
        const { keyword: installedKeyword, app } = installed
        newNode.type = 'app'
        newNode.data = { keyword: installedKeyword, config: {} }
        if (newNodeOutputHandle === 'prev') {
          newNode.position.x -= 20
          newNode.position.y -= 20
        } else if (newNodeOutputHandle === 'next') {
          newNode.position.x -= 270
          newNode.position.y -= 20
        } else {
          newNode.position.x -= 20
          newNode.position.y -= 100
          // Note: we place apps at a rough estimate above the node they're connected to. should be improved
          for (const field of app.fields ?? []) {
            newNode.position.y -= 30 + ('type' in field && field.type === 'text' ? (field.rows ?? 3) * 20 : 0)
          }
          if (app.cache) {
            ;(newNode.data as AppNodeData).cache = { ...app.cache }
          }
        }
      } else if (value.startsWith('dispatch/')) {
        const eventKeyword = value.substring(9)
        newNode.type = 'dispatch'
        newNode.data = { keyword: eventKeyword, config: {} } satisfies DispatchNodeData
        if (newNodeOutputHandle === 'prev') {
          newNode.position.x -= 20
          newNode.position.y -= 20
        } else if (newNodeOutputHandle === 'next') {
          newNode.position.x -= 270
          newNode.position.y -= 20
        } else {
          newNode.position.x -= 20
          newNode.position.y -= 20
        }
      } else {
        return
      }

      // Dragged onto the canvas from a "+" codefield arg
      if (handleId === 'codeField/+') {
        const codeArgs = (values.nodes.find((node) => node.id === nodeId)?.data as CodeNodeData)?.codeArgs ?? []
        let newArg = {
          name: keyword === '+' ? getNewFieldName(codeArgs) : keyword,
          type: type ?? 'string',
        } satisfies CodeArg
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
          const edges = values.edges
          let oldEdge: Edge | undefined
          let newEdge: Edge
          let extraEdge: Edge | undefined
          if (handleType === 'source') {
            oldEdge = edges.find((edge) => edge.source === nodeId && edge.sourceHandle === handleId)
            newEdge = {
              id: uuidv4(),
              target: newNode.id,
              targetHandle: newNodeOutputHandle,
              source: nodeId,
              sourceHandle: handleId,
            }
            extraEdge = oldEdge ? { ...oldEdge, source: newNode.id } : undefined
          } else {
            oldEdge = edges.find((edge) => edge.target === nodeId && edge.targetHandle === handleId)
            newEdge = {
              id: uuidv4(),
              source: newNode.id,
              sourceHandle: newNodeOutputHandle,
              target: nodeId,
              targetHandle: handleId,
            }
            extraEdge =
              oldEdge &&
              (oldEdge.sourceHandle === 'prev' ||
                oldEdge.targetHandle === 'prev' ||
                oldEdge.sourceHandle === 'next' ||
                oldEdge.targetHandle === 'next')
                ? { ...oldEdge, target: newNode.id }
                : oldEdge?.sourceHandle === 'fieldOutput' && newNode.type === 'code'
                ? {
                    ...oldEdge,
                    targetHandle: `codeField/${(newNode.data as CodeNodeData).codeArgs?.[0]?.name}`,
                    target: newNode.id,
                  }
                : undefined
          }

          if (oldEdge) {
            actions.setEdges(
              [...edges.filter((edge) => edge.id !== oldEdge?.id), newEdge, extraEdge].filter((a) => !!a) as Edge[]
            )
          } else {
            actions.setEdges([...values.edges, newEdge])
          }
          window.setTimeout(() => {
            props.updateNodeInternals?.(nodeId)
            props.updateNodeInternals?.(newNode.id)
          }, 200)
        }, 200)
      }

      actions.setSearchValue('')

      if (value === 'state') {
        const node = values.nodesById[nodeId]
        let label = keyword
        let value = ''
        if (node?.type === 'app') {
          const app = values.effectiveApps[(node.data as AppNodeData).keyword]
          const field: any = app?.fields?.find((f) => 'name' in f && f.name === keyword && 'label' in f)
          if (field?.label) {
            label = field?.label
          }
          if (field?.value) {
            value = field?.value
          }
        }

        if (!values.scene?.fields?.find((f) => f.name === keyword)) {
          actions.createField({
            name: keyword,
            label,
            type: type ?? 'string',
            value,
            persist: 'disk',
            access: 'public',
          })
        }
      }
    },
  })),
])
