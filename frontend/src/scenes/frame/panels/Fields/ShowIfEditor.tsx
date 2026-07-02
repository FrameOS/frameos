import { useState } from 'react'
import { Button } from '../../../../components/Button'
import { Select } from '../../../../components/Select'
import { TextInput } from '../../../../components/TextInput'
import { TextArea } from '../../../../components/TextArea'
import type {
  AppConfigField,
  ConfigFieldCondition,
  ConfigFieldConditionAnd,
  ConfigFieldConditionOperator,
} from '../../../../types'

export type ShowIfConditions = (ConfigFieldCondition | ConfigFieldConditionAnd)[]

interface ShowIfEditorProps {
  value: ShowIfConditions | undefined
  onChange: (showIf: ShowIfConditions | undefined) => void
  /** Sibling fields that conditions can reference */
  availableFields: Pick<AppConfigField, 'name' | 'type' | 'options'>[]
}

const operatorOptions: { value: ConfigFieldConditionOperator; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'ne', label: 'does not equal' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'in', label: 'is one of' },
  { value: 'notIn', label: 'is not one of' },
  { value: 'empty', label: 'is empty' },
  { value: 'notEmpty', label: 'is not empty' },
]

const operatorsWithoutValue = new Set<string>(['empty', 'notEmpty'])
const operatorsWithList = new Set<string>(['in', 'notIn'])

interface ParsedShowIf {
  mode: 'any' | 'all'
  rows: ConfigFieldCondition[]
}

/** Structures the row editor can represent; anything else falls back to raw JSON */
export function parseShowIfConditions(showIf: ShowIfConditions | undefined): ParsedShowIf | null {
  if (!showIf || showIf.length === 0) {
    return { mode: 'any', rows: [] }
  }
  const isSimple = (condition: ConfigFieldCondition | ConfigFieldConditionAnd): condition is ConfigFieldCondition =>
    !('and' in condition) && typeof condition.field === 'string' && !!condition.field
  if (showIf.length === 1 && 'and' in showIf[0]) {
    return showIf[0].and.every(isSimple) ? { mode: 'all', rows: showIf[0].and } : null
  }
  if (showIf.every(isSimple)) {
    return { mode: 'any', rows: showIf as ConfigFieldCondition[] }
  }
  return null
}

function serializeShowIf(mode: 'any' | 'all', rows: ConfigFieldCondition[]): ShowIfConditions | undefined {
  if (rows.length === 0) {
    return undefined
  }
  if (mode === 'all' && rows.length > 1) {
    return [{ and: rows }]
  }
  return rows
}

function coerceConditionValue(field: Pick<AppConfigField, 'type'> | undefined, raw: string): string | number | boolean {
  if (field?.type === 'boolean') {
    return raw === 'true'
  }
  if (field?.type === 'integer') {
    const parsed = parseInt(raw)
    return isNaN(parsed) ? raw : parsed
  }
  if (field?.type === 'float') {
    const parsed = parseFloat(raw)
    return isNaN(parsed) ? raw : parsed
  }
  return raw
}

function conditionValueToString(value: any): string {
  if (value === undefined || value === null) {
    return ''
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(', ')
  }
  return String(value)
}

function JsonConditionsEditor({ value, onChange }: Omit<ShowIfEditorProps, 'availableFields'>): JSX.Element {
  const [draft, setDraft] = useState(() => JSON.stringify(value ?? [], null, 2))
  const [error, setError] = useState(false)
  return (
    <div className="space-y-1">
      <div className="frame-tool-muted text-xs">
        These conditions are too complex for the visual editor. Edit them as JSON:
      </div>
      <TextArea
        value={draft}
        rows={5}
        onChange={(text) => {
          setDraft(text)
          try {
            const parsed = JSON.parse(text)
            if (Array.isArray(parsed)) {
              setError(false)
              onChange(parsed.length ? parsed : undefined)
              return
            }
          } catch (e) {}
          setError(true)
        }}
      />
      {error ? <div className="text-xs text-red-400">Invalid JSON — changes are not saved.</div> : null}
    </div>
  )
}

export function ShowIfEditor({ value, onChange, availableFields }: ShowIfEditorProps): JSX.Element {
  const parsed = parseShowIfConditions(value)
  if (!parsed) {
    return <JsonConditionsEditor value={value} onChange={onChange} />
  }
  const { mode, rows } = parsed
  const fieldByName = Object.fromEntries(availableFields.map((field) => [field.name, field]))
  const fieldOptions = availableFields
    .filter((field) => field.name)
    .map((field) => ({ label: field.name ?? '', value: field.name ?? '' }))

  const update = (newMode: 'any' | 'all', newRows: ConfigFieldCondition[]): void => {
    onChange(serializeShowIf(newMode, newRows))
  }

  const defaultValueFor = (fieldName: string): string | boolean | undefined => {
    const conditionField = fieldByName[fieldName]
    if (conditionField?.type === 'boolean') {
      return true
    }
    if (conditionField?.type === 'select') {
      return conditionField.options?.[0]
    }
    return undefined
  }

  const normalizeRow = (row: ConfigFieldCondition): ConfigFieldCondition => {
    const newRow = { ...row }
    const operator = String(newRow.operator ?? 'eq')
    if (operatorsWithoutValue.has(operator)) {
      delete newRow.value
      return newRow
    }
    if (operatorsWithList.has(operator)) {
      if (!Array.isArray(newRow.value)) {
        newRow.value = newRow.value === undefined || newRow.value === '' ? [] : [newRow.value]
      }
      return newRow
    }
    if (Array.isArray(newRow.value)) {
      newRow.value = newRow.value[0]
    }
    if (newRow.value === undefined) {
      // The value input displays a default for boolean/select fields; store
      // it so the saved condition matches what the user sees
      const fallback = defaultValueFor(newRow.field)
      if (fallback !== undefined) {
        newRow.value = fallback
      }
    }
    return newRow
  }

  const updateRow = (index: number, updates: Partial<ConfigFieldCondition>): void => {
    update(
      mode,
      rows.map((row, i) => (i === index ? normalizeRow({ ...row, ...updates }) : row))
    )
  }

  return (
    <div className="space-y-2">
      {rows.map((row, index) => {
        const conditionField = fieldByName[row.field]
        const needsValue = !operatorsWithoutValue.has(String(row.operator ?? 'eq'))
        const isList = operatorsWithList.has(String(row.operator))
        return (
          <div key={index} className="flex flex-wrap items-center gap-1">
            <Select
              value={row.field}
              options={
                row.field && !fieldByName[row.field]
                  ? [...fieldOptions, { label: row.field, value: row.field }]
                  : fieldOptions
              }
              onChange={(field) => updateRow(index, { field })}
              className="min-w-[8rem] flex-1"
            />
            <Select
              value={row.operator ?? 'eq'}
              options={operatorOptions}
              onChange={(operator) => updateRow(index, { operator: operator as ConfigFieldConditionOperator })}
              className="min-w-[7rem]"
            />
            {needsValue ? (
              isList ? (
                <TextInput
                  value={conditionValueToString(row.value)}
                  placeholder="value1, value2"
                  onChange={(text) =>
                    updateRow(index, {
                      value: text
                        .split(',')
                        .map((item) => item.trim())
                        .filter((item) => item !== '')
                        .map((item) => coerceConditionValue(conditionField, item)),
                    })
                  }
                  className="min-w-[7rem] flex-1"
                />
              ) : conditionField?.type === 'boolean' ? (
                <Select
                  value={String(row.value ?? 'true')}
                  options={[
                    { label: 'true', value: 'true' },
                    { label: 'false', value: 'false' },
                  ]}
                  onChange={(text) => updateRow(index, { value: text === 'true' })}
                  className="min-w-[7rem]"
                />
              ) : conditionField?.type === 'select' && conditionField.options?.length ? (
                <Select
                  value={conditionValueToString(row.value)}
                  options={conditionField.options.map((option) => ({ label: option, value: option }))}
                  onChange={(text) => updateRow(index, { value: text })}
                  className="min-w-[7rem]"
                />
              ) : (
                <TextInput
                  value={conditionValueToString(row.value)}
                  onChange={(text) => updateRow(index, { value: coerceConditionValue(conditionField, text) })}
                  className="min-w-[7rem] flex-1"
                />
              )
            ) : null}
            <Button
              size="small"
              color="secondary"
              onClick={() =>
                update(
                  mode,
                  rows.filter((_, i) => i !== index)
                )
              }
            >
              <span className="text-red-300">×</span>
            </Button>
          </div>
        )
      })}
      <div className="flex items-center gap-2">
        <Button
          size="small"
          color="secondary"
          onClick={() =>
            update(mode, [
              ...rows,
              normalizeRow({ field: fieldOptions[0]?.value ?? '', operator: 'eq' } as ConfigFieldCondition),
            ])
          }
          disabled={fieldOptions.length === 0 && rows.length === 0}
        >
          Add condition
        </Button>
        {rows.length > 1 ? (
          <Select
            value={mode}
            options={[
              { label: 'match any condition', value: 'any' },
              { label: 'match all conditions', value: 'all' },
            ]}
            onChange={(newMode) => update(newMode === 'all' ? 'all' : 'any', rows)}
          />
        ) : null}
      </div>
      {fieldOptions.length === 0 && rows.length === 0 ? (
        <div className="frame-tool-muted text-xs">Add another field first to set up visibility conditions.</div>
      ) : null}
    </div>
  )
}
