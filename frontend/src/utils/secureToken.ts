/**
 * `bytes` random bytes as base64url text, from the browser's own generator.
 * What is made with it is a frame's access key, an admin password, an agent
 * secret, a view token or an upload id: where the browser has no
 * `crypto.getRandomValues` it throws, since `Math.random` (the fallback
 * until 2026-11-24) is predictable and none of those may be.
 */
export function secureToken(bytes: number): string {
  const source = globalThis.crypto
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new Error('This browser has no secure random number generator (crypto.getRandomValues).')
  }
  const randomBytes = new Uint8Array(bytes)
  source.getRandomValues(randomBytes)

  const numberArray = Array.from(randomBytes)
  const base64String = btoa(String.fromCharCode.apply(null, numberArray))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  return base64String
}
