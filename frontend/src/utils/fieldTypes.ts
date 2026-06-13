import { FrameScene, FrameType, StateField } from '../types'
import { sceneExecutionForFrame } from './sceneExecution'

export const fieldTypeToGetter: Record<string, string> = {
  integer: '.getInt()',
  string: '.getStr()',
  text: '.getStr()',
  boolean: '.getBool()',
  float: '.getFloat()',
  select: '.getStr()',
  json: '',
}

export function stateFieldAccess(
  scene: FrameScene | null,
  field: StateField,
  objectName = 'state',
  frameMode?: FrameType['mode'] | null
): string {
  const isInterpreted = sceneExecutionForFrame(scene, frameMode) === 'interpreted'
  if (isInterpreted) {
    // if the field name is a simple stirng, do dot access
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(field.name)) {
      return `${objectName}.${field.name}`
    }
    return `${objectName}[${JSON.stringify(field.name)}]`
  }
  return `${objectName}{${JSON.stringify(field.name)}}${
    fieldTypeToGetter[String(field.type ?? 'string')] ?? '.getStr()'
  }`
}
