## BLAKE2b-512 (RFC 7693), needed to verify minisign release signatures.
##
## minisign's prehashed mode ("ED") signs Ed25519 over BLAKE2b-512 of the
## file, so verifying a FrameOS release archive needs this digest and nothing
## else. Ed25519 itself comes from libcrypto (frameos/cloud/identity.nim);
## BLAKE2b does not, because the loader there already has to cope with
## LibreSSL builds that lack algorithms OpenSSL has, and an update path that
## silently stops verifying on such a host would be worse than one that never
## worked. A hundred lines of well-specified, test-vectored arithmetic is the
## cheaper side of that trade.
##
## Streaming on purpose: a release archive is tens of megabytes and a Pi Zero
## should not hold one in memory twice.

import std/streams

type
  Blake2bCtx* = object
    h: array[8, uint64]
    t: array[2, uint64]   ## 128-bit counter of bytes compressed so far
    buf: array[128, byte]
    bufLen: int
    digestLen: int

const
  Blake2bIV: array[8, uint64] = [
    0x6a09e667f3bcc908'u64, 0xbb67ae8584caa73b'u64,
    0x3c6ef372fe94f82b'u64, 0xa54ff53a5f1d36f1'u64,
    0x510e527fade682d1'u64, 0x9b05688c2b3e6c1f'u64,
    0x1f83d9abfb41bd6b'u64, 0x5be0cd19137e2179'u64,
  ]

  Sigma: array[12, array[16, int]] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
    # Rounds 10 and 11 reuse the first two rows (RFC 7693 §2.7).
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  ]

func rotr(x: uint64, n: int): uint64 {.inline.} =
  (x shr uint64(n)) or (x shl uint64(64 - n))

func load64(buf: openArray[byte], offset: int): uint64 {.inline.} =
  ## Little-endian, per the spec.
  var value: uint64 = 0
  for i in countdown(7, 0):
    value = (value shl 8) or uint64(buf[offset + i])
  value

proc compress(ctx: var Blake2bCtx, last: bool) =
  var m: array[16, uint64]
  for i in 0 ..< 16:
    m[i] = load64(ctx.buf, i * 8)

  var v: array[16, uint64]
  for i in 0 ..< 8:
    v[i] = ctx.h[i]
    v[i + 8] = Blake2bIV[i]
  v[12] = v[12] xor ctx.t[0]
  v[13] = v[13] xor ctx.t[1]
  if last:
    v[14] = not v[14]

  template g(a, b, c, d, x, y: untyped) =
    v[a] = v[a] + v[b] + x
    v[d] = rotr(v[d] xor v[a], 32)
    v[c] = v[c] + v[d]
    v[b] = rotr(v[b] xor v[c], 24)
    v[a] = v[a] + v[b] + y
    v[d] = rotr(v[d] xor v[a], 16)
    v[c] = v[c] + v[d]
    v[b] = rotr(v[b] xor v[c], 63)

  for round in 0 ..< 12:
    let s = Sigma[round]
    g(0, 4, 8, 12, m[s[0]], m[s[1]])
    g(1, 5, 9, 13, m[s[2]], m[s[3]])
    g(2, 6, 10, 14, m[s[4]], m[s[5]])
    g(3, 7, 11, 15, m[s[6]], m[s[7]])
    g(0, 5, 10, 15, m[s[8]], m[s[9]])
    g(1, 6, 11, 12, m[s[10]], m[s[11]])
    g(2, 7, 8, 13, m[s[12]], m[s[13]])
    g(3, 4, 9, 14, m[s[14]], m[s[15]])

  for i in 0 ..< 8:
    ctx.h[i] = ctx.h[i] xor v[i] xor v[i + 8]

proc initBlake2b*(digestLen = 64): Blake2bCtx =
  ## Unkeyed BLAKE2b. `digestLen` is in bytes (64 for BLAKE2b-512).
  doAssert digestLen > 0 and digestLen <= 64, "BLAKE2b digest length must be 1..64 bytes"
  result.h = Blake2bIV
  # Parameter block: digest length, key length (0), fanout 1, depth 1.
  result.h[0] = result.h[0] xor 0x01010000'u64 xor uint64(digestLen)
  result.digestLen = digestLen

proc update*(ctx: var Blake2bCtx, data: openArray[byte]) =
  for b in data:
    if ctx.bufLen == 128:
      # Compress only once the NEXT byte is known to exist: the final block
      # must be compressed with the `last` flag, so a full buffer is not
      # flushed until something proves it is not the end.
      ctx.t[0] = ctx.t[0] + 128
      if ctx.t[0] < 128:
        ctx.t[1] = ctx.t[1] + 1
      compress(ctx, false)
      ctx.bufLen = 0
    ctx.buf[ctx.bufLen] = b
    ctx.bufLen += 1

proc update*(ctx: var Blake2bCtx, data: string) =
  update(ctx, toOpenArrayByte(data, 0, data.high))

proc digest*(ctx: var Blake2bCtx): string =
  ## Finalizes and returns the raw digest bytes (not hex).
  ctx.t[0] = ctx.t[0] + uint64(ctx.bufLen)
  if ctx.t[0] < uint64(ctx.bufLen):
    ctx.t[1] = ctx.t[1] + 1
  for i in ctx.bufLen ..< 128:
    ctx.buf[i] = 0
  compress(ctx, true)

  result = newString(ctx.digestLen)
  for i in 0 ..< ctx.digestLen:
    result[i] = char((ctx.h[i div 8] shr uint64(8 * (i mod 8))) and 0xff'u64)

proc blake2b512*(data: string): string =
  var ctx = initBlake2b(64)
  ctx.update(data)
  ctx.digest()

proc blake2b512File*(path: string, chunkSize = 1 shl 20): string =
  ## Streams the file so a multi-megabyte release archive is never held in
  ## memory just to be hashed.
  var ctx = initBlake2b(64)
  let stream = newFileStream(path, fmRead)
  if stream == nil:
    raise newException(IOError, "Cannot open for hashing: " & path)
  defer: stream.close()
  var chunk = newString(chunkSize)
  while true:
    let got = stream.readData(addr chunk[0], chunkSize)
    if got <= 0:
      break
    ctx.update(toOpenArrayByte(chunk, 0, got - 1))
  ctx.digest()
