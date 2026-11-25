/**
 * Web Serial availability, and — when it is missing — why.
 *
 * Browsers expose `navigator.serial` only in a secure context: https://, or
 * http:// on localhost. FrameOS is very often reached over neither. The Home
 * Assistant add-on is often opened as a plain
 * `http://homeassistant.local:8123/...`, and a self-hosted backend on the LAN
 * is plain http too. In both cases `navigator.serial` is simply absent, and a
 * feature check alone reports "your browser doesn't support Web Serial" to
 * someone sitting in an up-to-date Chrome — sending them off to reinstall a
 * browser that was never the problem. Separating the two cases is the
 * difference between a one-line fix and a support thread.
 *
 * A page in a frame of another origin that was not delegated the `serial`
 * permission has the object but may not use it (requestPort throws a
 * SecurityError): a secure page, and still no USB. (A same-origin frame, as
 * Home Assistant's ingress over https is, inherits the permission.)
 *
 * Either way flash.frameos.net can do the USB part for the page
 * (utils/flasherBridge.ts): webSerialNeedsFlasher says when.
 */

/** The page is in a frame that may not use Web Serial (Permissions Policy). */
export function webSerialBlockedByPolicy(): boolean {
  if (typeof document === 'undefined') {
    return false
  }
  const policy = (document as any).permissionsPolicy ?? (document as any).featurePolicy
  if (!policy || typeof policy.allowsFeature !== 'function') {
    return false
  }
  try {
    return policy.allowsFeature('serial') === false
  } catch {
    return false
  }
}

export function webSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator && !webSerialBlockedByPolicy()
}

/** Web Serial is missing specifically because this page is not a secure origin. */
export function webSerialBlockedByInsecureContext(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !('serial' in navigator) &&
    typeof window !== 'undefined' &&
    window.isSecureContext === false
  )
}

/** This browser could use Web Serial, but not on this page: hand the USB
 * work to flash.frameos.net. */
export function webSerialNeedsFlasher(): boolean {
  return webSerialBlockedByInsecureContext() || webSerialBlockedByPolicy()
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
  if (webSerialBlockedByPolicy()) {
    return `${action} needs Web Serial, which the page FrameOS is embedded in does not allow it to use.`
  }
  return `${action} needs Web Serial, which this browser doesn't support. Use Chrome or Edge.`
}
