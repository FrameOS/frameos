// A photo's EXIF block (date taken, camera, GPS location) carried from the
// original into a copy the browser encoded ("Resize and upload" with "Keep
// metadata"). A canvas writes no metadata, so the block is read from the
// original's bytes and put into the copy's: a JPEG's APP1 segment, a PNG's
// eXIf chunk, a WebP's EXIF chunk. The block is the TIFF structure itself
// ("II*\0" or "MM\0*"), and its Orientation is set to 1, because the copy is
// already drawn the way up the photo is seen.
//
// Pure byte functions, pinned by the shared-spa test resize-image-file.test.ts.

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00] // "Exif\0\0"

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) {
    return false
  }
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) {
      return false
    }
  }
  return true
}

function startsWithExifHeader(bytes: Uint8Array, offset: number): boolean {
  return EXIF_HEADER.every((value, i) => bytes[offset + i] === value)
}

function isTiff(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a))
  )
}

/** A byte, 0 past the end (the cloud build checks every index). */
function at(bytes: ArrayLike<number>, offset: number): number {
  return bytes[offset] ?? 0
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((at(bytes, offset) << 24) |
      (at(bytes, offset + 1) << 16) |
      (at(bytes, offset + 2) << 8) |
      at(bytes, offset + 3)) >>>
    0
  )
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (at(bytes, offset) |
      (at(bytes, offset + 1) << 8) |
      (at(bytes, offset + 2) << 16) |
      (at(bytes, offset + 3) << 24)) >>>
    0
  )
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** The EXIF block (TIFF bytes) of a JPEG, PNG or WebP, or null when it has none. */
export function readExif(bytes: Uint8Array): Uint8Array | null {
  // JPEG: segments after SOI until the scan.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1]
      if (marker === 0xda || marker === 0xd9) {
        break
      }
      const length = (at(bytes, offset + 2) << 8) | at(bytes, offset + 3)
      if (length < 2) {
        break
      }
      if (marker === 0xe1 && startsWithExifHeader(bytes, offset + 4)) {
        const tiff = bytes.slice(offset + 10, Math.min(bytes.length, offset + 2 + length))
        return isTiff(tiff) ? tiff : null
      }
      offset += 2 + length
    }
    return null
  }
  // PNG: chunks after the signature.
  if (ascii(bytes, 1, 'PNG') && bytes[0] === 0x89) {
    let offset = 8
    while (offset + 12 <= bytes.length) {
      const length = u32be(bytes, offset)
      if (ascii(bytes, offset + 4, 'eXIf')) {
        const tiff = bytes.slice(offset + 8, offset + 8 + length)
        return isTiff(tiff) ? tiff : null
      }
      if (ascii(bytes, offset + 4, 'IEND')) {
        break
      }
      offset += 12 + length
    }
    return null
  }
  // WebP: RIFF chunks, padded to even sizes.
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) {
    let offset = 12
    while (offset + 8 <= bytes.length) {
      const size = u32le(bytes, offset + 4)
      if (ascii(bytes, offset, 'EXIF')) {
        let start = offset + 8
        if (startsWithExifHeader(bytes, start)) {
          start += 6
        }
        const tiff = bytes.slice(start, offset + 8 + size)
        return isTiff(tiff) ? tiff : null
      }
      offset += 8 + size + (size & 1)
    }
  }
  return null
}

/** A copy of the block with IFD0's Orientation (0x0112) set to 1, when it has one. */
export function exifWithUprightOrientation(tiff: Uint8Array): Uint8Array {
  const out = tiff.slice()
  if (!isTiff(out)) {
    return out
  }
  const little = out[0] === 0x49
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const ifd = view.getUint32(4, little)
  if (ifd + 2 > out.length) {
    return out
  }
  const count = view.getUint16(ifd, little)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > out.length) {
      break
    }
    if (view.getUint16(entry, little) === 0x0112 && view.getUint16(entry + 2, little) === 3) {
      view.setUint16(entry + 8, 1, little)
    }
  }
  return out
}

let crcTable: Uint32Array | null = null

/** PNG's CRC-32 over `bytes`. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = at(crcTable, (crc ^ byte) & 0xff) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

function le32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff])
}

function le24(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff])
}

/**
 * `encoded` (a JPEG, PNG or WebP a canvas wrote, `width`×`height`) with the
 * EXIF block put in. Unchanged when the format is none of those, or the block
 * does not fit a JPEG segment.
 */
export function writeExif(
  encoded: Uint8Array<ArrayBuffer>,
  tiff: Uint8Array,
  width: number,
  height: number
): Uint8Array<ArrayBuffer> {
  if (!isTiff(tiff)) {
    return encoded
  }
  // JPEG: an APP1 segment near the start.
  if (encoded[0] === 0xff && encoded[1] === 0xd8) {
    const length = 2 + EXIF_HEADER.length + tiff.length
    if (length > 0xffff) {
      return encoded
    }
    // After a JFIF APP0 when there is one: JFIF wants its segment first.
    let insertAt = 2
    if (encoded[2] === 0xff && encoded[3] === 0xe0) {
      insertAt = 4 + ((at(encoded, 4) << 8) | at(encoded, 5))
    }
    const head = new Uint8Array([0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...EXIF_HEADER])
    return concat([encoded.slice(0, insertAt), head, tiff, encoded.slice(insertAt)])
  }
  // PNG: an eXIf chunk after IHDR, before the image data.
  if (encoded[0] === 0x89 && ascii(encoded, 1, 'PNG') && ascii(encoded, 12, 'IHDR')) {
    const ihdrEnd = 8 + 12 + u32be(encoded, 8)
    const type = new Uint8Array([0x65, 0x58, 0x49, 0x66]) // "eXIf"
    const chunk = concat([be32(tiff.length), type, tiff, be32(crc32(concat([type, tiff])))])
    return concat([encoded.slice(0, ihdrEnd), chunk, encoded.slice(ihdrEnd)])
  }
  // WebP: a VP8X header saying there is EXIF, and the EXIF chunk last.
  if (ascii(encoded, 0, 'RIFF') && ascii(encoded, 8, 'WEBP')) {
    const pad = tiff.length & 1 ? new Uint8Array([0]) : new Uint8Array(0)
    const exifChunk = concat([new TextEncoder().encode('EXIF'), le32(tiff.length), tiff, pad])
    let body: Uint8Array<ArrayBuffer> = encoded.slice(12)
    if (ascii(body, 0, 'VP8X')) {
      body = body.slice()
      body[8] = at(body, 8) | 0x08
    } else {
      // A simple file (one VP8 or VP8L chunk): it gets the extended header.
      let flags = 0x08
      if (ascii(body, 0, 'VP8L') && body.length >= 13) {
        // VP8L: after the 0x2f signature, 14 + 14 bits of size, then alpha_is_used.
        const bits = u32le(body, 9)
        if ((bits >>> 28) & 1) {
          flags |= 0x10
        }
      }
      const vp8x = concat([
        new TextEncoder().encode('VP8X'),
        le32(10),
        new Uint8Array([flags, 0, 0, 0]),
        le24(width - 1),
        le24(height - 1),
      ])
      body = concat([vp8x, body])
    }
    const riffBody = concat([new TextEncoder().encode('WEBP'), body, exifChunk])
    return concat([new TextEncoder().encode('RIFF'), le32(riffBody.length), riffBody])
  }
  return encoded
}
