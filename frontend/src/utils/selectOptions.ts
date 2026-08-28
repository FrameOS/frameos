import { Option } from '../components/Select'
import type { SelectFieldOption } from '../types'

/**
 * A select field's options are either plain strings, or `{ value, label }` pairs when the
 * stored value and the text shown differ. Scenes are hand-edited, imported and AI-written,
 * so options also arrive as numbers or as half-filled objects; read every `field.options`
 * through here. A raw non-string rendered as a React child takes the whole editor down.
 */
function optionValue(option: unknown): string | null {
  if (typeof option === 'string') {
    return option
  }
  if (typeof option === 'number' || typeof option === 'boolean') {
    return String(option)
  }
  if (option && typeof option === 'object' && !Array.isArray(option)) {
    return optionValue((option as { value?: unknown }).value)
  }
  return null
}

function optionLabel(option: unknown, value: string): string {
  if (option && typeof option === 'object' && !Array.isArray(option)) {
    const label = (option as { label?: unknown }).label
    if (typeof label === 'string' || typeof label === 'number' || typeof label === 'boolean') {
      return String(label)
    }
  }
  return value
}

/** The values of a select field, for storing, comparing and code generation. */
export function selectFieldValues(options: unknown): string[] {
  return selectFieldOptions(options).map((option) => option.value)
}

/** The options of a select field, ready for <Select />. Unusable entries are dropped. */
export function selectFieldOptions(options: unknown): Option[] {
  if (!Array.isArray(options)) {
    return []
  }
  const result: Option[] = []
  for (const option of options) {
    const value = optionValue(option)
    if (value !== null) {
      result.push({ value, label: optionLabel(option, value) })
    }
  }
  return result
}

/** Canonical storage shape: a plain string unless the option carries its own label. */
export function normalizeSelectOptions(options: unknown): SelectFieldOption[] {
  return selectFieldOptions(options).map(({ value, label }) => (label === value ? value : { value, label }))
}

/**
 * Options stored in a shape the editor and the frame cannot read (numbers, half-filled
 * objects) get canonicalized, so the next save writes a scene the device can parse.
 * Returned untouched when already canonical.
 */
export function normalizeFieldOptions<T>(field: T): T {
  const options = (field as { options?: unknown } | null | undefined)?.options
  if (options === undefined) {
    return field
  }
  const normalized = normalizeSelectOptions(options)
  const unchanged =
    Array.isArray(options) &&
    options.length === normalized.length &&
    normalized.every((option, index) =>
      typeof option === 'string'
        ? options[index] === option
        : isSameLabeledOption(options[index], option.value, option.label)
    )
  return unchanged ? field : ({ ...field, options: normalized } as T)
}

function isSameLabeledOption(option: unknown, value: string, label: string): boolean {
  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    return false
  }
  const entry = option as { value?: unknown; label?: unknown }
  return entry.value === value && entry.label === label && Object.keys(entry).length === 2
}

/** The options textarea in the field editor: one option per line, `value | Label` when labeled. */
export function selectOptionsToText(options: unknown): string {
  return selectFieldOptions(options)
    .map(({ value, label }) => (label === value ? value : `${value} | ${label}`))
    .join('\n')
}

export function selectOptionsFromText(text: string): SelectFieldOption[] {
  return text.split('\n').map((line) => {
    const separator = line.indexOf('|')
    if (separator === -1) {
      return line
    }
    const value = line.slice(0, separator).trim()
    const label = line.slice(separator + 1).trim()
    return label && label !== value ? { value, label } : value
  })
}
