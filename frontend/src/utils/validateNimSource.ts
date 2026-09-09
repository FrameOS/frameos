import { apiFetch } from './apiFetch'
import { isCloudMode } from './cloudMode'
import { isFrameControlMode } from './frameControlMode'

export interface SourceError {
  line: number
  column: number
  error: string
}

/**
 * Inline `nim check` for app and scene sources. Only the self-hosted backend
 * has `/api/apps/validate_source`; the cloud, a frame's own admin panel and
 * the standalone embedded editor do not, so posting there was one guaranteed
 * 404 per keystroke — and the callers destructured `response.json()` without
 * an `ok` check, so on the embed (synthetic 404, body `null`) every
 * validation was an unhandled rejection and stale errors never cleared.
 */
export function canValidateNimSource(): boolean {
  if (typeof window !== 'undefined' && (window as any).FRAMEOS_EMBEDDED_NO_BACKEND) {
    return false
  }
  return !isCloudMode() && !isFrameControlMode()
}

/** The endpoint runs `nim check`; only Nim sources belong there. */
export function isNimSourceFile(file: string): boolean {
  return file.toLowerCase().endsWith('.nim')
}

/**
 * Validate one Nim source. Resolves to `null` when nothing validated this
 * file (no backend, not a Nim file, the request failed) — callers clear the
 * file's errors in that case rather than keeping stale ones.
 */
export async function validateNimSource(file: string, source: string): Promise<SourceError[] | null> {
  if (!canValidateNimSource() || !isNimSourceFile(file)) {
    return null
  }
  try {
    const response = await apiFetch(`/api/apps/validate_source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, source }),
    })
    if (!response.ok) {
      return null
    }
    const payload = (await response.json()) as { errors?: unknown } | null
    const errors = Array.isArray(payload?.errors) ? payload.errors : []
    return errors.filter(
      (error): error is SourceError =>
        !!error &&
        typeof error === 'object' &&
        typeof (error as SourceError).line === 'number' &&
        typeof (error as SourceError).column === 'number' &&
        typeof (error as SourceError).error === 'string'
    )
  } catch (error) {
    console.error('Source validation failed', error)
    return null
  }
}
