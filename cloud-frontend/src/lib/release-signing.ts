/**
 * The FrameOS release signing key, as the browser needs it.
 *
 * Every release asset — the Linux runtime archives, the ESP32 images and the
 * Buildroot SD-card images — is signed with one minisign key. The devices
 * carry the raw Ed25519 public key (frameos/src/frameos/ota_pubkey.nim,
 * embedded/esp32/main/fos_ota.c), the self-hosted backend verifies with it
 * on every download and cache hit (backend/app/utils/release_signing.py),
 * and the `curl | sh` installer does the same with nothing but openssl. The
 * SD image builder was the one reader of a release asset that trusted what
 * it downloaded: the cloud route streams GitHub's bytes through unchanged,
 * and this module is how the browser checks them before a card is written.
 *
 * Same check the devices make: BLAKE2b-512 over the whole (compressed) file,
 * Ed25519 over that digest — minisign's prehashed mode. WebCrypto has
 * Ed25519 but no BLAKE2b, so the hash is the small 32-bit-halves
 * implementation below (RFC 7693; the shape of the public-domain blakejs
 * one), fed the download chunk by chunk as it streams.
 *
 * `cloud/apps/auth-web/src/test/shared-spa/release-signing.test.ts` pins the
 * key constant to the Nim one, so a key rotation cannot leave the browser
 * refusing every release.
 */

// Raw 32-byte Ed25519 public key, base64 — byte-for-byte
// OtaSigningPublicKeyBase64 in frameos/src/frameos/ota_pubkey.nim.
export const RELEASE_SIGNING_PUBLIC_KEY_BASE64 = '0LvFbK8ePu0fSujVkabbyzo0gEppxSV3qhyBHQfaoMw='

let publicKeyOverride: string | undefined

/** Tests sign their fixtures with a throwaway key; production never calls this. */
export function overrideReleaseSigningKeyForTests(publicKeyBase64: string | undefined): void {
  publicKeyOverride = publicKeyBase64
}

export function releaseSigningPublicKeyBase64(): string {
  return publicKeyOverride ?? RELEASE_SIGNING_PUBLIC_KEY_BASE64
}

export class ReleaseSignatureError extends Error {
  constructor(
    message: string,
    public readonly code: 'malformed_signature' | 'signature_mismatch' | 'signature_unavailable'
  ) {
    super(message)
    this.name = 'ReleaseSignatureError'
  }
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * The 64 signature bytes from a .minisig file (or from just its signature
 * line).
 *
 * The first non-comment line is base64(ED || keyid8 || sig64): "ED" marks
 * minisign's prehashed mode. The trusted-comment line and its global
 * signature are ignored on purpose — a KEY is trusted, not a comment —
 * mirroring parse_minisig_signature in the backend, parseMinisigSignature in
 * frameos/src/frameos/upgrade.nim and parse_minisig in fos_ota.c.
 */
export function parseMinisigSignature(minisig: string): Uint8Array {
  for (const rawLine of minisig.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('untrusted comment:') || line.startsWith('trusted comment:')) {
      continue
    }
    let blob: Uint8Array
    try {
      blob = decodeBase64(line)
    } catch {
      throw new ReleaseSignatureError('Release signature is not valid base64', 'malformed_signature')
    }
    if (blob.length !== 74) {
      throw new ReleaseSignatureError(
        `Release signature blob has the wrong length (${blob.length}, expected 74)`,
        'malformed_signature'
      )
    }
    if (blob[0] !== 0x45 || blob[1] !== 0x44) {
      throw new ReleaseSignatureError(
        'Release signature is not the prehashed Ed25519 form FrameOS uses',
        'malformed_signature'
      )
    }
    return blob.slice(10, 74)
  }
  throw new ReleaseSignatureError('Release signature file contained no signature line', 'malformed_signature')
}

/**
 * Check a BLAKE2b-512 digest of a release asset against its .minisig. Throws
 * ReleaseSignatureError; resolves when the asset was signed by the release
 * key.
 */
export async function verifyReleaseDigest(digest: Uint8Array, minisig: string): Promise<void> {
  const signature = parseMinisigSignature(minisig)
  const rawKey = decodeBase64(releaseSigningPublicKeyBase64())
  if (rawKey.length !== 32) {
    throw new ReleaseSignatureError('Release signing key is not a 32-byte Ed25519 key', 'malformed_signature')
  }
  const key = await crypto.subtle.importKey('raw', rawKey as BufferSource, { name: 'Ed25519' }, false, ['verify'])
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, signature as BufferSource, digest as BufferSource)
  if (!ok) {
    throw new ReleaseSignatureError(
      'The downloaded image does not match the FrameOS release signature — refusing to write it. ' +
        'Try again; if it keeps failing the download was corrupted or tampered with.',
      'signature_mismatch'
    )
  }
}

// ---------------------------------------------------------------------------
// BLAKE2b (RFC 7693), unkeyed, on 32-bit halves: JavaScript has no native
// 64-bit integers and BigInt arithmetic per round is an order of magnitude
// slower than this. Only the 64-byte output is needed here.

const BLAKE2B_IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a, 0xade682d1,
  0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
])

// prettier-ignore
const SIGMA8 = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
]
// Each entry doubled: an index into the 32-bit-halves message array.
const SIGMA82 = new Uint8Array(SIGMA8.map((value) => value * 2))

export class Blake2b512 {
  private readonly h = new Uint32Array(16)
  private readonly b = new Uint8Array(128)
  private readonly v = new Uint32Array(32)
  private readonly m = new Uint32Array(32)
  private t = 0
  private c = 0
  private finished = false

  constructor() {
    this.h.set(BLAKE2B_IV32)
    // Parameter block: digest length 64, no key, fanout 1, depth 1.
    this.h[0] = this.h[0]! ^ 0x01010000 ^ 64
  }

  update(input: Uint8Array): this {
    if (this.finished) {
      throw new Error('Blake2b512: update after digest')
    }
    let offset = 0
    while (offset < input.length) {
      if (this.c === 128) {
        this.t += 128
        this.compress(false)
        this.c = 0
      }
      const take = Math.min(128 - this.c, input.length - offset)
      this.b.set(input.subarray(offset, offset + take), this.c)
      this.c += take
      offset += take
    }
    return this
  }

  digest(): Uint8Array {
    if (this.finished) {
      throw new Error('Blake2b512: digest called twice')
    }
    this.finished = true
    this.t += this.c
    this.b.fill(0, this.c)
    this.compress(true)
    const out = new Uint8Array(64)
    for (let index = 0; index < 64; index++) {
      out[index] = this.h[index >> 2]! >> (8 * (index & 3))
    }
    return out
  }

  private compress(last: boolean): void {
    const { v, m, h, b } = this
    for (let index = 0; index < 16; index++) {
      v[index] = h[index]!
      v[index + 16] = BLAKE2B_IV32[index]!
    }
    // Byte counter, low and high 32 bits.
    v[24] = v[24]! ^ this.t
    v[25] = v[25]! ^ (this.t / 0x100000000)
    if (last) {
      v[28] = ~v[28]!
      v[29] = ~v[29]!
    }
    for (let index = 0; index < 32; index++) {
      const at = 4 * index
      m[index] = b[at]! ^ (b[at + 1]! << 8) ^ (b[at + 2]! << 16) ^ (b[at + 3]! << 24)
    }
    for (let round = 0; round < 12; round++) {
      const s = round * 16
      this.g(0, 8, 16, 24, SIGMA82[s]!, SIGMA82[s + 1]!)
      this.g(2, 10, 18, 26, SIGMA82[s + 2]!, SIGMA82[s + 3]!)
      this.g(4, 12, 20, 28, SIGMA82[s + 4]!, SIGMA82[s + 5]!)
      this.g(6, 14, 22, 30, SIGMA82[s + 6]!, SIGMA82[s + 7]!)
      this.g(0, 10, 20, 30, SIGMA82[s + 8]!, SIGMA82[s + 9]!)
      this.g(2, 12, 22, 24, SIGMA82[s + 10]!, SIGMA82[s + 11]!)
      this.g(4, 14, 16, 26, SIGMA82[s + 12]!, SIGMA82[s + 13]!)
      this.g(6, 8, 18, 28, SIGMA82[s + 14]!, SIGMA82[s + 15]!)
    }
    for (let index = 0; index < 16; index++) {
      h[index] = h[index]! ^ v[index]! ^ v[index + 16]!
    }
  }

  // 64-bit v[a] += v[b], unsigned, on halves.
  private add64aa(a: number, b: number): void {
    const v = this.v
    const o0 = v[a]! + v[b]!
    let o1 = v[a + 1]! + v[b + 1]!
    if (o0 >= 0x100000000) {
      o1++
    }
    v[a] = o0
    v[a + 1] = o1
  }

  // 64-bit v[a] += (b0, b1), where the halves come from the message array.
  private add64ac(a: number, b0: number, b1: number): void {
    const v = this.v
    let o0 = v[a]! + b0
    if (b0 < 0) {
      o0 += 0x100000000
    }
    let o1 = v[a + 1]! + b1
    if (o0 >= 0x100000000) {
      o1++
    }
    v[a] = o0
    v[a + 1] = o1
  }

  private g(a: number, b: number, c: number, d: number, ix: number, iy: number): void {
    const { v, m } = this
    const x0 = m[ix]!
    const x1 = m[ix + 1]!
    const y0 = m[iy]!
    const y1 = m[iy + 1]!

    this.add64aa(a, b)
    this.add64ac(a, x0, x1)
    // v[d] = rotr64(v[d] ^ v[a], 32): swap the halves.
    let xor0 = v[d]! ^ v[a]!
    let xor1 = v[d + 1]! ^ v[a + 1]!
    v[d] = xor1
    v[d + 1] = xor0

    this.add64aa(c, d)
    // v[b] = rotr64(v[b] ^ v[c], 24)
    xor0 = v[b]! ^ v[c]!
    xor1 = v[b + 1]! ^ v[c + 1]!
    v[b] = (xor0 >>> 24) ^ (xor1 << 8)
    v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8)

    this.add64aa(a, b)
    this.add64ac(a, y0, y1)
    // v[d] = rotr64(v[d] ^ v[a], 16)
    xor0 = v[d]! ^ v[a]!
    xor1 = v[d + 1]! ^ v[a + 1]!
    v[d] = (xor0 >>> 16) ^ (xor1 << 16)
    v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16)

    this.add64aa(c, d)
    // v[b] = rotr64(v[b] ^ v[c], 63)
    xor0 = v[b]! ^ v[c]!
    xor1 = v[b + 1]! ^ v[c + 1]!
    v[b] = (xor1 >>> 31) ^ (xor0 << 1)
    v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1)
  }
}

/** A pass-through transform that feeds every chunk into the hasher. */
export function hashingTransform<T extends Uint8Array>(hasher: Blake2b512): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(chunk, controller) {
      hasher.update(chunk)
      controller.enqueue(chunk)
    },
  })
}
