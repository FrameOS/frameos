import { AppConfigField, FrameScene, FrameType, StateField, StateFieldRole } from '../types'
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

/**
 * `fields` with field `index` given `role` (`enabled`) or relieved of it. A
 * role names one field per scene, so every other field loses that role; a
 * field holds one role at a time, so taking a role replaces the one it had.
 * Other fields keep their other roles.
 */
export function withStateFieldRole<T extends AppConfigField>(
  fields: T[],
  index: number,
  role: StateFieldRole,
  enabled: boolean
): T[] {
  return fields.map((field, i) => {
    const current = (field as StateField).role
    if (i === index) {
      const { role: _role, ...rest } = field as StateField
      return (enabled ? { ...rest, role } : current === role ? rest : field) as T
    }
    if (current === role) {
      const { role: _role, ...rest } = field as StateField
      return rest as T
    }
    return field
  })
}
