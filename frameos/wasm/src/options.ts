import type { SelectFieldOption, StateField } from './types'

/**
 * A select field's options are either plain strings, or `{ value, label }` pairs when the
 * stored value and the text shown differ. Scenes are hand-edited, imported and AI-written,
 * so options also arrive as numbers or half-filled objects; read them through here.
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

/** The value/label pairs of a select field, ready to render. Unusable entries are dropped. */
export function selectFieldOptions(options: StateField['options'] | unknown): { value: string; label: string }[] {
  if (!Array.isArray(options)) {
    return []
  }
  const result: { value: string; label: string }[] = []
  for (const option of options as SelectFieldOption[]) {
    const value = optionValue(option)
    if (value !== null) {
      result.push({ label: optionLabel(option, value), value })
    }
  }
  return result
}
