export function isNumericString(value?: string | null): boolean {
  return !!String(value || '').match(/^\-?[0-9]+(|\.[0-9]+)$/)
}
