import { AppConfig, AppNodeData, DispatchNodeData, FrameEvent, FrameScene, FrameType } from '../types'
import { v4 as uuidv4 } from 'uuid'

import _events from '../../schema/events.json'
const frameEvents = _events as FrameEvent[]

/** Duplicate scenes, giving each a new unique ID */
export function duplicateScenes(newScenes: FrameScene[]): FrameScene[] {
  const sceneIds: Record<string, string> = {} // oldId -> newId
  function getNewSceneId(id: string): string {
    if (sceneIds[id]) {
      return sceneIds[id]
    } else {
      const newId = uuidv4()
      sceneIds[id] = newId
      return newId
    }
  }
  return newScenes.map((scene: FrameScene): FrameScene => {
    const id = getNewSceneId(scene.id)
    const frameScene: FrameScene = {
      ...scene,
      id,
      nodes: scene.nodes.map((node) => {
        if (node.type === 'code' || node.type === 'state' || node.type === 'event' || node.type === 'app') {
          return node
        } else if (node.type === 'dispatch') {
          const data = node.data as DispatchNodeData
          const { keyword, config } = data
          const frameEvent = frameEvents.find((event) => event.name === keyword)
          if (!frameEvent?.fields?.find((field) => field.type === 'scene')) {
            return node
          }
          const newConfig = { ...config }
          for (const field of frameEvent?.fields) {
            if (field.type === 'scene' && newConfig[field.name]) {
              newConfig[field.name] = getNewSceneId(newConfig[field.name])
            }
          }
          return { ...node, data: { ...data, config: newConfig } }
        } else if (node.type === 'source') {
          try {
            const data = node.data as AppNodeData
            const configJsonSource = data.sources?.['config.json'] ?? '{}'
            const configSource: AppConfig = JSON.parse(configJsonSource)
            if (configSource.fields?.find((field) => 'type' in field && field.type === 'scene')) {
              const newConfig = { ...data.config }
              for (const field of configSource.fields) {
                if ('type' in field && field.type === 'scene' && newConfig[field.name]) {
                  newConfig[field.name] = getNewSceneId(newConfig[field.name])
                }
              }
              const newConfigFields = configSource.fields.map((field) => {
                if ('type' in field && field.type === 'scene') {
                  return { ...field, value: field.value ? getNewSceneId(field.value) : field.value }
                }
              })
              return {
                ...node,
                data: { ...data, config: newConfig },
                sources: {
                  ...data.sources,
                  'config.json': JSON.stringify({ ...configSource, fields: newConfigFields }, null, 2),
                },
              }
            }
          } catch (e) {
            console.error('Error while parsing config.json', e, node)
          }
          return node
        } else {
          throw new Error(`Unknown node type, can't clone: ${node.type}`)
        }
      }),
      edges: scene.edges.map((edge) => ({ ...edge })),
      fields: scene.fields?.map((field) => {
        if (field.type === 'scene') {
          return { ...field, value: field.value ? getNewSceneId(field.value) : field.value }
        }
        return field
      }),
    }
    return structuredClone(frameScene)
  })
}
