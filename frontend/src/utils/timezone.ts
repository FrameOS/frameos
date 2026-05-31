export const DEFAULT_TIMEZONE = 'UTC'

export function guessBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE
  } catch (error) {
    return DEFAULT_TIMEZONE
  }
}

export function normalizedTimezone(value?: string | null, fallback?: string | null): string {
  return value?.trim() || fallback?.trim() || guessBrowserTimezone()
}
