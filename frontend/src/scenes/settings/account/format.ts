// Display helpers for the account pages. Ports of the cloud's own
// (cloud/apps/auth-web/src/lib/format.ts, ai-usage-format.ts), so the pages
// read the same as the Next.js versions they replaced.

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024) {
      break
    }
    value /= 1024
    unit = next
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

// Dates are rendered unambiguously ("9 Jul 2026") instead of locale-dependent
// numeric formats like 7/9/2026, which read differently across countries.
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatDate(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) {
    return typeof value === 'string' ? value : ''
  }
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`
}

export function formatDateTime(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) {
    return typeof value === 'string' ? value : ''
  }
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${formatDate(date)}, ${hours}:${minutes}`
}

/** "never" for a missing timestamp, otherwise the date and time. */
export function formatDateTimeOrNever(value: string | null | undefined): string {
  return value ? formatDateTime(value) : 'never'
}

// Micro-dollars (as the decimal string every cloud payload carries them in,
// since JSON's number would round a bigint) to dollars, rounding UP to the
// cent: a tenth of a cent of usage should read as $0.01, never as nothing at
// all. Negative amounts (a credit in the customer's favour) keep their sign.
export function dollars(micros: bigint | string | number): string {
  const value = typeof micros === 'bigint' ? micros : BigInt(String(micros || '0').split('.')[0] || '0')
  const negative = value < 0n
  const absolute = negative ? -value : value
  const cents = (absolute + 9_999n) / 10_000n
  return `${negative ? '-' : ''}$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`
}

// Surface slugs are for the database. These are for people.
const surfaceLabels: Record<string, string> = {
  app_chat: 'App code assistant',
  scene_chat: 'Scene chat',
  scene_convert: 'Scene converter',
  store_classify: 'Store classification',
  store_recategorize: 'Store recategorization',
}

export function surfaceLabel(surface: string | null | undefined): string {
  if (!surface) {
    return 'Other'
  }
  return surfaceLabels[surface] ?? surface.replace(/_/g, ' ')
}
