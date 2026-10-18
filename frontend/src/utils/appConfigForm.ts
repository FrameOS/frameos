// The config.json form in the app editor (EditApp/AppConfigForm.tsx): what it
// reads from the source, how it writes the source back, and the edits it
// makes. The source stays the truth, so anything the form does not know
// (a key from a newer FrameOS, a field's runtime `capabilities`) survives.

import type { AppConfigField, CacheConfig, MarkdownField, OutputField } from '../types'

export type AppConfigEntry = AppConfigField | MarkdownField
/** A parsed config.json: an object, possibly missing keys or carrying unknown ones. */
export type AppConfigDraft = Record<string, unknown>

export function isMarkdownEntry(entry: AppConfigEntry): entry is MarkdownField {
  return typeof entry === 'object' && entry !== null && 'markdown' in entry
}

export function parseAppConfigSource(source: string | undefined): {
  config: AppConfigDraft | null
  error: string | null
} {
  if (source === undefined || source.trim() === '') {
    return { config: {}, error: null }
  }
  try {
    const parsed: unknown = JSON.parse(source)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: null, error: 'config.json must hold one JSON object.' }
    }
    return { config: parsed as AppConfigDraft, error: null }
  } catch (error) {
    return { config: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function inlineJson(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length ? `[${value.map(inlineJson).join(', ')}]` : '[]'
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    return entries.length
      ? `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${inlineJson(item)}`).join(', ')} }`
      : '{}'
  }
  return JSON.stringify(value) ?? 'null'
}

function formatJsonValue(value: unknown, indent: number, prefix: number, width: number, expand: boolean): string {
  const flat = inlineJson(value)
  const container = (Array.isArray(value) && value.length > 0) || (!!value && typeof value === 'object')
  // +1 for the comma that usually follows.
  if (!container || (!expand && indent + prefix + flat.length + 1 <= width)) {
    return flat
  }
  const pad = ' '.repeat(indent + 2)
  const end = ' '.repeat(indent)
  if (Array.isArray(value)) {
    return `[\n${value.map((item) => pad + formatJsonValue(item, indent + 2, 0, width, false)).join(',\n')}\n${end}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
  if (!entries.length) {
    return '{}'
  }
  return `{\n${entries
    .map(([key, item]) => {
      const name = `${JSON.stringify(key)}: `
      return pad + name + formatJsonValue(item, indent + 2, name.length, width, false)
    })
    .join(',\n')}\n${end}}`
}

/** JSON the way the repo's config.json files are written (prettier, 120 wide):
 * anything that fits on its line stays on it. */
export function formatAppConfigJson(config: AppConfigDraft, width = 120): string {
  return formatJsonValue(config, 0, 0, width, true) + '\n'
}

/** `config` written in the style its file already has: a plain
 * JSON.stringify dump stays one (same indent, same final newline), anything
 * else gets formatAppConfigJson. An edit then touches only its own lines. */
export function formatAppConfigLike(previousSource: string | undefined, config: AppConfigDraft): string {
  const previous = previousSource ? parseAppConfigSource(previousSource).config : null
  if (previous && previousSource) {
    const indent = /\n( +)"/.exec(previousSource)?.[1]?.length ?? 2
    const newline = previousSource.endsWith('\n') ? '\n' : ''
    if (previousSource === JSON.stringify(previous, null, indent) + newline) {
      return JSON.stringify(config, null, indent) + newline
    }
  }
  return formatAppConfigJson(config)
}

// Keys whose empty value means "not set": dropped rather than written out.
// An empty `settings` list is kept: saving falls back to the app's previous
// list when the key is missing (buildSceneApp), so [] is how it is cleared.
const DROPPED_WHEN_EMPTY = new Set(['description', 'category', 'version', 'cache'])
// Where a key the file does not have yet goes, as the repo's apps write them.
const KEY_ORDER = [
  'name',
  'description',
  'category',
  'version',
  'origin',
  'settings',
  'permissions',
  'apt',
  'fields',
  'output',
  'cache',
]

function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (!!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
  )
}

export function withConfigKey(config: AppConfigDraft, key: string, value: unknown): AppConfigDraft {
  if (value === undefined || (DROPPED_WHEN_EMPTY.has(key) && isEmptyValue(value))) {
    const next = { ...config }
    delete next[key]
    return next
  }
  if (key in config || !KEY_ORDER.includes(key)) {
    return { ...config, [key]: value }
  }
  const entries = Object.entries(config)
  const rank = KEY_ORDER.indexOf(key)
  const before = entries.findIndex(([other]) => KEY_ORDER.includes(other) && KEY_ORDER.indexOf(other) > rank)
  entries.splice(before >= 0 ? before : entries.length, 0, [key, value])
  return Object.fromEntries(entries)
}

export function configEntries(config: AppConfigDraft | null): AppConfigEntry[] {
  return Array.isArray(config?.fields) ? (config!.fields as AppConfigEntry[]) : []
}

export function configOutputs(config: AppConfigDraft | null): OutputField[] {
  return Array.isArray(config?.output) ? (config!.output as OutputField[]) : []
}

export function configStrings(config: AppConfigDraft | null, key: string): string[] {
  const value = config?.[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function configCache(config: AppConfigDraft | null): CacheConfig {
  const cache = config?.cache
  return cache && typeof cache === 'object' && !Array.isArray(cache) ? (cache as CacheConfig) : {}
}

/** `patch` merged into one object; a key set to undefined is removed. */
export function patchObject<T extends object>(item: T, patch: Record<string, unknown>): T {
  const next = { ...item } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
  }
  return next as T
}

export function moveItem<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) {
    return items
  }
  const next = [...items]
  const [moved] = next.splice(index, 1) as [T]
  next.splice(target, 0, moved)
  return next
}

/** A codename not used yet: field, field2, field3, ... */
export function unusedName(base: string, taken: string[]): string {
  const names = new Set(taken)
  if (!names.has(base)) {
    return base
  }
  let counter = 2
  while (names.has(`${base}${counter}`)) {
    counter += 1
  }
  return `${base}${counter}`
}

export function newConfigField(entries: AppConfigEntry[]): AppConfigField {
  const name = unusedName(
    'field',
    entries.filter((entry): entry is AppConfigField => !isMarkdownEntry(entry)).map((entry) => entry.name)
  )
  return { name, label: codenameToLabel(name), type: 'string', value: '' }
}

export function codenameToLabel(codename: string): string {
  const label = codename
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : ''
}

/** A field's codename change, carrying a label that was generated from the old one along with it. */
export function renamedField(field: AppConfigField, name: string): AppConfigField {
  const labelWasGenerated = !field.label || field.label === codenameToLabel(field.name ?? '')
  return { ...field, name, label: labelWasGenerated ? codenameToLabel(name) : field.label }
}

/** Show-if conditions and seq ranges that name a field follow it when it is renamed. */
export function renameFieldReferences(entries: AppConfigEntry[], from: string, to: string): AppConfigEntry[] {
  if (!from || from === to) {
    return entries
  }
  const renameCondition = <C extends { field?: string }>(condition: C): C =>
    condition.field === from ? { ...condition, field: to } : condition
  return entries.map((entry) => {
    let next = entry
    if (Array.isArray(entry.showIf)) {
      next = {
        ...next,
        showIf: (entry.showIf as any[]).map((condition) =>
          condition && Array.isArray(condition.and)
            ? { ...condition, and: condition.and.map(renameCondition) }
            : renameCondition(condition)
        ),
      } as AppConfigEntry
    }
    if (!isMarkdownEntry(entry) && Array.isArray(entry.seq)) {
      next = {
        ...next,
        seq: entry.seq.map(([name, start, end]) => [name, start === from ? to : start, end === from ? to : end]),
      } as AppConfigEntry
    }
    return next
  })
}

/** A default value as the field editor shows it. */
export function fieldValueText(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }
  return typeof value === 'string' ? value : JSON.stringify(value)
}
