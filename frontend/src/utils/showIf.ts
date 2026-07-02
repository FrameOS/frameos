import type { AppConfigField, ConfigFieldCondition, ConfigFieldConditionAnd, MarkdownField, StateField } from '../types'

export interface ShowIfEvaluationOptions {
  /** Values for special `.meta.*` condition fields, e.g. { '.meta.showOutput': true } */
  metaValues?: Record<string, any>
  /** Field names that have an incoming connection, and thus always count as "not empty" */
  connectedFields?: string[]
}

/**
 * Evaluate a single showIf condition. Conditions in an `and` block must all match;
 * top level conditions are OR-ed together by evaluateShowIf below.
 */
function matchCondition(
  condition: ConfigFieldCondition | ConfigFieldConditionAnd,
  values: Record<string, any>,
  currentFieldName: string | null,
  options: ShowIfEvaluationOptions
): boolean {
  if ('and' in condition) {
    return condition.and.every((cond) => matchCondition(cond, values, currentFieldName, options))
  }

  const { value, operator, field: fieldName } = condition
  const field = fieldName || currentFieldName || ''
  const metaValues = options.metaValues ?? {}
  const connectedFields = options.connectedFields ?? []

  const actualValue = fieldName && fieldName in metaValues ? metaValues[fieldName] : values[field]
  const isConnected = connectedFields.includes(field)

  if (operator === 'eq') {
    return actualValue === value
  } else if (operator === 'ne') {
    return actualValue !== value
  } else if (operator === 'gt') {
    return actualValue > value
  } else if (operator === 'lt') {
    return actualValue < value
  } else if (operator === 'gte') {
    return actualValue >= value
  } else if (operator === 'lte') {
    return actualValue <= value
  } else if (operator === 'in') {
    return !!value?.includes?.(actualValue)
  } else if (operator === 'notIn') {
    return !value?.includes?.(actualValue)
  } else if (operator === 'empty') {
    return !actualValue && !isConnected
  } else if (operator === 'notEmpty') {
    return !!actualValue || isConnected
  } else if (operator === null && value === null && fieldName?.startsWith('.meta.')) {
    return !!actualValue
  }
  return value !== undefined ? value === actualValue : !!actualValue || isConnected
}

/**
 * Evaluate a field's showIf conditions against the given values.
 * Returns true when the field should be visible: no conditions, or at least one
 * top-level condition matches (top-level conditions are OR-ed, `and` blocks are AND-ed).
 */
export function evaluateShowIf(
  conditions: (ConfigFieldCondition | ConfigFieldConditionAnd)[] | undefined,
  values: Record<string, any>,
  currentFieldName?: string | null,
  options: ShowIfEvaluationOptions = {}
): boolean {
  if (!conditions || conditions.length === 0) {
    return true
  }
  return conditions.some((condition) => matchCondition(condition, values, currentFieldName ?? null, options))
}

/**
 * Filter a list of fields down to those whose showIf conditions pass.
 * Works for app config fields, state fields and custom event fields alike.
 */
export function filterFieldsByShowIf<T extends Partial<AppConfigField> | MarkdownField>(
  fields: T[],
  values: Record<string, any>,
  options: ShowIfEvaluationOptions = {}
): T[] {
  return fields.filter((field) =>
    evaluateShowIf(field.showIf, values, 'name' in field ? field.name ?? null : null, options)
  )
}

/**
 * Coerce a raw form value (usually a string) to the field's type so that
 * showIf comparisons ("eq", "gt", ...) behave the same in every form and on
 * the frame itself.
 */
export function coerceStateFieldValue(field: Pick<StateField, 'type'>, value: any): any {
  if (value === undefined || value === null) {
    return value
  }
  if (field.type === 'boolean') {
    return value === true || value === 'true'
  }
  if (field.type === 'integer') {
    const parsed = typeof value === 'number' ? Math.trunc(value) : parseInt(value)
    return isNaN(parsed) ? undefined : parsed
  }
  if (field.type === 'float') {
    const parsed = typeof value === 'number' ? value : parseFloat(value)
    return isNaN(parsed) ? undefined : parsed
  }
  return value
}

/** Build the values map used for showIf checks: field defaults overlaid with the given sources */
export function stateFieldShowIfValues(
  fields: Pick<StateField, 'name' | 'type' | 'value'>[],
  ...valueSources: (Record<string, any> | null | undefined)[]
): Record<string, any> {
  const values: Record<string, any> = {}
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
 * The public state fields that should be visible in a control/activation
 * form, given the current values (later sources win, defaults fill the gaps).
 */
export function visiblePublicStateFields<T extends Pick<StateField, 'name' | 'type' | 'value' | 'access' | 'showIf'>>(
  fields: T[],
  ...valueSources: (Record<string, any> | null | undefined)[]
): T[] {
  const publicFields = fields.filter((field) => field.access === 'public')
  const values = stateFieldShowIfValues(publicFields, ...valueSources)
  return publicFields.filter((field) => evaluateShowIf(field.showIf, values, field.name ?? null))
}
