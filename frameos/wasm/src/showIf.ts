// showIf evaluation for scene state fields. A framework-free mirror of
// frontend/src/utils/showIf.ts (which itself mirrors the Nim implementation
// in frameos/src/frameos/utils/show_if.nim) — keep the three in sync.
import type { ShowIfCondition, StateField } from './types'

function matchCondition(
  condition: ShowIfCondition,
  values: Record<string, unknown>,
  currentFieldName: string | null
): boolean {
  if ('and' in condition) {
    return condition.and.every((cond) => matchCondition(cond, values, currentFieldName))
  }

  const { value, operator, field: fieldName } = condition
  const field = fieldName || currentFieldName || ''
  const actualValue = values[field] as any

  if (operator === 'eq') {
    return actualValue === value
  } else if (operator === 'ne') {
    return actualValue !== value
  } else if (operator === 'gt') {
    return actualValue > (value as any)
  } else if (operator === 'lt') {
    return actualValue < (value as any)
  } else if (operator === 'gte') {
    return actualValue >= (value as any)
  } else if (operator === 'lte') {
    return actualValue <= (value as any)
  } else if (operator === 'in') {
    return !!(value as any)?.includes?.(actualValue)
  } else if (operator === 'notIn') {
    return !(value as any)?.includes?.(actualValue)
  } else if (operator === 'empty') {
    return !actualValue
  } else if (operator === 'notEmpty') {
    return !!actualValue
  }
  return value !== undefined ? value === actualValue : !!actualValue
}

/**
 * True when the field should be visible: no conditions, or at least one
 * top-level condition matches (top level is OR-ed, `and` blocks are AND-ed).
 */
export function evaluateShowIf(
  conditions: ShowIfCondition[] | undefined,
  values: Record<string, unknown>,
  currentFieldName?: string | null
): boolean {
  if (!conditions || conditions.length === 0) {
    return true
  }
  return conditions.some((condition) => matchCondition(condition, values, currentFieldName ?? null))
}

/**
 * Coerce a raw form value (usually a string) to the field's type so showIf
 * comparisons behave the same as on the frame itself.
 */
export function coerceStateFieldValue(field: Pick<StateField, 'type'>, value: unknown): unknown {
  if (value === undefined || value === null) {
    return value
  }
  if (field.type === 'boolean') {
    return value === true || value === 'true'
  }
  if (field.type === 'integer') {
    const parsed = typeof value === 'number' ? Math.trunc(value) : parseInt(String(value))
    return isNaN(parsed) ? undefined : parsed
  }
  if (field.type === 'float') {
    const parsed = typeof value === 'number' ? value : parseFloat(String(value))
    return isNaN(parsed) ? undefined : parsed
  }
  return value
}

/** The values map for showIf checks: field defaults overlaid with the sources. */
export function stateFieldShowIfValues(
  fields: StateField[],
  ...valueSources: (Record<string, unknown> | null | undefined)[]
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of fields) {
    if (!field.name) {
      continue
    }
    let value = field.value
    for (const source of valueSources) {
      if (source && field.name in source && source[field.name] !== undefined) {
        value = source[field.name]
      }
    }
    const coerced = coerceStateFieldValue(field, value)
    if (coerced !== undefined) {
      values[field.name] = coerced
    }
  }
  return values
}

/**
 * The public state fields visible in a control form given the current values
 * (later sources win, defaults fill the gaps).
 */
export function visiblePublicStateFields(
  fields: StateField[],
  ...valueSources: (Record<string, unknown> | null | undefined)[]
): StateField[] {
  const publicFields = fields.filter((field) => field.access === 'public')
  const values = stateFieldShowIfValues(publicFields, ...valueSources)
  return publicFields.filter((field) => evaluateShowIf(field.showIf, values, field.name ?? null))
}
