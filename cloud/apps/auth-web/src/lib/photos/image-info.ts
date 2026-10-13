// Width and height from an image's header bytes, for the four types the cloud
// stores (JPEG, PNG, GIF, WebP). The cloud has no image library on the server,
// and the contract only needs the two numbers, so this reads them straight
// out of the format headers without decoding a pixel.
//
// The numbers match what a browser reports as naturalWidth/naturalHeight: a
// JPEG whose EXIF orientation turns it a quarter (5-8) has them swapped, the
// way browsers display it.

export type ImageDimensions = { height: number; width: number };

export function imageDimensions(
  bytes: Buffer,
  contentType: string,
): ImageDimensions | undefined {
  try {
    switch (contentType) {
      case "image/jpeg":
        return jpegDimensions(bytes);
      case "image/png":
        return pngDimensions(bytes);
      case "image/gif":
        return gifDimensions(bytes);
      case "image/webp":
        return webpDimensions(bytes);
      default:
        return undefined;
    }
  } catch {
    // A header that ends early reads past the buffer: unknown, not an error.
    return undefined;
  }
}

function positive(width: number, height: number): ImageDimensions | undefined {
  return width > 0 && height > 0 ? { height, width } : undefined;
}

function pngDimensions(bytes: Buffer) {
  // Signature (8), then the IHDR chunk: length (4), "IHDR" (4), width, height.
  if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") {
    return undefined;
  }
  return positive(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function gifDimensions(bytes: Buffer) {
  // "GIF8?a", then the logical screen width and height, little endian.
  if (bytes.length < 10) {
    return undefined;
  }
  return positive(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
}

function webpDimensions(bytes: Buffer) {
  // Each branch below reads past the chunk header; a buffer that ends early
  // throws a RangeError there, which imageDimensions turns into "unknown".
  if (
    bytes.length < 16 ||
    bytes.toString("latin1", 0, 4) !== "RIFF" ||
    bytes.toString("latin1", 8, 12) !== "WEBP"
  ) {
    return undefined;
  }
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    // Flags (1) + reserved (3) at 20, then canvas width-1 and height-1 as
    // 24-bit little-endian numbers.
    return positive(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
  }
  if (chunk === "VP8L") {
    // Signature byte 0x2f at 20, then 14 bits of width-1 and 14 of height-1.
    if (bytes[20] !== 0x2f) {
      return undefined;
    }
    const bits = bytes.readUInt32LE(21);
    return positive((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8 ") {
    // Frame tag (3) at 20, start code 9d 01 2a at 23, then 14-bit width and
    // height (the top two bits of each are the scale).
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return undefined;
    }
    return positive(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  }
  return undefined;
}

// Start-of-frame markers carry the size: C0-CF except C4 (DHT), C8 (JPG
// extension) and CC (DAC).
function isStartOfFrame(marker: number) {
  return (
    marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
  );
}

function jpegDimensions(bytes: Buffer) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let orientation = 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return undefined;
    }
    // Any number of 0xff fill bytes may precede a marker.
    let markerAt = offset + 1;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) {
      markerAt += 1;
    }
    const marker = bytes[markerAt];
    if (marker === undefined) {
      return undefined;
    }
    // Standalone markers have no length: TEM, RST0-7, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset = markerAt + 1;
      continue;
    }
    // End of image or start of scan before any frame header: give up.
    if (marker === 0xd9 || marker === 0xda) {
      return undefined;
    }
    const length = bytes.readUInt16BE(markerAt + 1);
    if (length < 2) {
      return undefined;
    }
    const segmentStart = markerAt + 3;
    if (marker === 0xe1) {
      orientation =
        exifOrientation(bytes.subarray(segmentStart, markerAt + 1 + length)) ?? orientation;
    }
    if (isStartOfFrame(marker)) {
      // Precision (1), height (2), width (2).
      const height = bytes.readUInt16BE(segmentStart + 1);
      const width = bytes.readUInt16BE(segmentStart + 3);
      return orientation >= 5 && orientation <= 8
        ? positive(height, width)
        : positive(width, height);
    }
    offset = markerAt + 1 + length;
  }
  return undefined;
}

/** The EXIF orientation tag (1-8) of an APP1 segment's payload, if any. */
export function exifOrientation(segment: Buffer): number | undefined {
  if (segment.length < 14 || segment.toString("latin1", 0, 6) !== "Exif\0\0") {
    return undefined;
  }
  const tiff = segment.subarray(6);
  const byteOrder = tiff.toString("latin1", 0, 2);
  const little = byteOrder === "II";
  if (!little && byteOrder !== "MM") {
    return undefined;
  }
  const read16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const read32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (read16(2) !== 42) {
    return undefined;
  }
  const ifd = read32(4);
  if (ifd + 2 > tiff.length) {
    return undefined;
  }
  const count = read16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > tiff.length) {
      return undefined;
    }
    if (read16(entry) === 0x0112) {
      // Type SHORT, count 1: the value sits in the first two bytes of the
      // value field.
      const value = read16(entry + 8);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}
