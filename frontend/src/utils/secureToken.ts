export function secureToken(bytes: number): string {
  const randomBytes = new Uint8Array(bytes)
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(randomBytes)
  } else {
    for (let i = 0; i < randomBytes.length; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256)
    }
  }

  const numberArray = Array.from(randomBytes)
  const base64String = btoa(String.fromCharCode.apply(null, numberArray))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  return base64String
}
