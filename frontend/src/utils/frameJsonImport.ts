import type { FrameType } from '../types'

export interface ImportedFrameJson {
  /** The keys the settings form takes, with their values from the file. */
  values: Partial<FrameType>
  /** Keys the file carried that the form does not: server-owned state (id, deploy baseline, fingerprints) and unknowns. */
  ignoredKeys: string[]
}

/**
 * Parse an exported frame .json into settings-form values. Only keys the
 * form edits come through — the export is the whole frame row, so it also
 * carries the id, the deploy baseline, secret fingerprints and the like,
 * none of which belong in the form (and the id must never move between
 * frames). Throws on malformed input; the message is for the user.
 */
export function parseImportedFrameJson(text: string, formKeys: readonly (keyof FrameType)[]): ImportedFrameJson {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('The file is not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The file does not contain a frame: expected one JSON object.')
  }
  const record = parsed as Record<string, unknown>
  const allowed = new Set<string>(formKeys)
  const values: Record<string, unknown> = {}
  const ignoredKeys: string[] = []
  for (const [key, value] of Object.entries(record)) {
    if (allowed.has(key)) {
      values[key] = value
    } else {
      ignoredKeys.push(key)
    }
  }
  if (Object.keys(values).length === 0) {
    throw new Error('The file does not contain any frame settings.')
  }
  return { values: values as Partial<FrameType>, ignoredKeys }
}
