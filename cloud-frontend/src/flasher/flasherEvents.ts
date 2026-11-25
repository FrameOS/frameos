// What the flasher counts (cloud/docs/flasher.md "What is counted"): how often
// the page is opened, and each flash, update or settings run, started and
// finished, with the board and how it went. Never a name, a network, a
// backend's address or the scenes' contents; the server keeps only what is
// on its lists (cloud/apps/auth-web/src/lib/flasher-events.ts).
//
// Nothing is stored on the device: the visit id lives in this page's memory,
// so one visit's events belong together and the next visit is a stranger.

export const FLASHER_EVENTS_PATH = '/api/flasher/events'

export type FlasherEventName =
  | 'flasher opened'
  | 'flasher flash started'
  | 'flasher flash finished'
  | 'flasher tool used'

export type FlasherEventProperties = Record<string, string | number | boolean | null | undefined>

function newVisitId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const visit = newVisitId()

/** Sends one count, and never waits for it or fails for it. */
export function sendFlasherEvent(event: FlasherEventName, properties: FlasherEventProperties = {}): void {
  const kept = Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== null && value !== undefined)
  )
  try {
    void fetch(FLASHER_EVENTS_PATH, {
      method: 'POST',
      // Survives the tab closing right after a flash.
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, visit, properties: kept }),
    }).catch(() => undefined)
  } catch {
    // No count, no harm.
  }
}
