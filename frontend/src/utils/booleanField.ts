/**
 * A boolean field's value the way the frame reads it (`valueFromJsonByType`
 * + `parseBoolish` in frameos/src/frameos/values.nim): a JSON boolean as is,
 * a string when it is "true", "1", "yes" or "y" in any case, anything else
 * false. Scene and app configs hold both shapes — the editor writes the
 * strings "true"/"false", while app defaults, imported and AI-built scenes
 * carry real booleans — so comparing with `== 'true'` showed a `true`
 * default as unchecked.
 */
export function booleanFieldValue(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase())
  }
  return false
}
