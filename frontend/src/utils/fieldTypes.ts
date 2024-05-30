import { StateField } from '../types'

export const fieldTypeToGetter: Record<string, string> = {
  integer: '.getInt()',
  string: '.getStr()',
  text: '.getStr()',
  boolean: '.getBool()',
  float: '.getFloat()',
  select: '.getStr()',
  json: '',
}

export function stateFieldAccess(field: StateField, objectName = 'state'): string {
  return `${objectName}{"${field.name}"}${fieldTypeToGetter[String(field.type ?? 'string')] ?? '.getStr()'}`
}
