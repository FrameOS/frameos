/**
 * Web Serial availability, and — when it is missing — why.
 *
 * Browsers expose `navigator.serial` only in a secure context: https://, or
 * http:// on localhost. FrameOS is very often reached over neither. The Home
 * Assistant add-on runs behind ingress, so the usual address is a plain
 * `http://homeassistant.local:8123/...`, and a self-hosted backend on the LAN
 * is plain http too. In both cases `navigator.serial` is simply absent, and a
 * feature check alone reports "your browser doesn't support Web Serial" to
 * someone sitting in an up-to-date Chrome — sending them off to reinstall a
 * browser that was never the problem. Separating the two cases is the
 * difference between a one-line fix and a support thread.
 */

export function webSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

/** Web Serial is missing specifically because this page is not a secure origin. */
export function webSerialBlockedByInsecureContext(): boolean {
  return !webSerialSupported() && typeof window !== 'undefined' && window.isSecureContext === false
}

/**
 * One sentence naming the actual cause, for the "USB is unavailable" branches.
 * Callers append whatever alternative their own view offers.
 */
export function webSerialUnavailableReason(action = 'This'): string {
  if (webSerialBlockedByInsecureContext()) {
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    return (
      `${action} needs Web Serial, which browsers only offer on a secure page. ` +
      `FrameOS is open over ${origin || 'plain http'} — reach it over https:// (or http://localhost) to enable it.`
    )
  }
  return `${action} needs Web Serial, which this browser doesn't support. Use Chrome or Edge.`
}
