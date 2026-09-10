import { Inflate, strFromU8 } from "fflate";

// Bounded extraction of an untrusted zip. fflate's unzipSync inflates each
// selected entry into a buffer sized by the central directory's declared
// uncompressed size, so a check on `originalSize` bounds what a well-formed
// zip costs — but the field is just a number the uploader wrote, and an
// understated one buys an inflate that either silently truncates (today's
// fflate) or grows with the real output (any inflater that resizes). The
// bound here is on the bytes that actually come out: every selected entry
// is inflated through the streaming Inflate in small compressed slices and
// the running total is checked after each, so a bomb is stopped within one
// slice of the ceiling no matter what its headers claim. The declared sizes
// are still summed first as the cheap pre-check.
//
// Only what template zips need: stored and deflated entries, no zip64, no
// encryption — anything else is refused as a bounds error, the same word
// the callers already map to "invalid zip".

export const maxSceneZipUncompressedBytes = 32 * 1024 * 1024;
export const maxSceneZipEntries = 200;

// Compressed bytes per Inflate.push. Deflate tops out near 1032:1, so one
// slice can add at most ~8 MB before the total is checked again.
const inflateSliceBytes = 8 * 1024;

export class ZipBoundsError extends Error {
  constructor(message = "zip_bounds_exceeded") {
    super(message);
    this.name = "ZipBoundsError";
  }
}

export type ZipBounds = {
  maxEntries?: number;
  maxUncompressedBytes?: number;
};

function u16(data: Uint8Array, offset: number) {
  return data[offset]! | (data[offset + 1]! << 8);
}

function u32(data: Uint8Array, offset: number) {
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

const endOfCentralDirectory = 0x06054b50;
const centralDirectoryHeader = 0x02014b50;
const localFileHeader = 0x04034b50;
const zip64Locator = 0x07064b50;

/**
 * The entries `select` picks, by name, inflated under the bounds. Entries
 * not selected are counted (entry count, declared size) but never inflated.
 * Throws ZipBoundsError when a bound is exceeded and a plain Error when the
 * zip is malformed.
 */
export function unzipBounded(
  data: Uint8Array,
  select: (name: string) => boolean,
  bounds: ZipBounds = {},
): Record<string, Uint8Array> {
  const maxEntries = bounds.maxEntries ?? maxSceneZipEntries;
  const maxBytes = bounds.maxUncompressedBytes ?? maxSceneZipUncompressedBytes;
  if (data.length < 22) {
    throw new Error("invalid_zip");
  }
  let end = data.length - 22;
  while (u32(data, end) !== endOfCentralDirectory) {
    if (end === 0 || data.length - end > 65558) {
      throw new Error("invalid_zip");
    }
    end -= 1;
  }
  if (end >= 20 && u32(data, end - 20) === zip64Locator) {
    throw new ZipBoundsError("zip64_unsupported");
  }
  const entryCount = u16(data, end + 8);
  let offset = u32(data, end + 16);
  if (entryCount === 0xffff || offset === 0xffffffff) {
    throw new ZipBoundsError("zip64_unsupported");
  }
  if (entryCount > maxEntries) {
    throw new ZipBoundsError();
  }

  const files: Record<string, Uint8Array> = {};
  let declaredTotal = 0;
  let actualTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > data.length || u32(data, offset) !== centralDirectoryHeader) {
      throw new Error("invalid_zip");
    }
    const flags = u16(data, offset + 8);
    const compression = u16(data, offset + 10);
    const compressedSize = u32(data, offset + 20);
    const declaredSize = u32(data, offset + 24);
    const nameLength = u16(data, offset + 28);
    const extraLength = u16(data, offset + 30);
    const commentLength = u16(data, offset + 32);
    const localOffset = u32(data, offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > data.length) {
      throw new Error("invalid_zip");
    }
    const name = strFromU8(data.subarray(offset + 46, nameEnd), !(flags & 0x800));
    offset = nameEnd + extraLength + commentLength;

    declaredTotal += declaredSize;
    if (declaredTotal > maxBytes) {
      throw new ZipBoundsError();
    }
    if (!select(name)) {
      continue;
    }
    if (flags & 0x1) {
      throw new ZipBoundsError("encrypted_entry");
    }
    if (localOffset + 30 > data.length || u32(data, localOffset) !== localFileHeader) {
      throw new Error("invalid_zip");
    }
    const dataStart =
      localOffset + 30 + u16(data, localOffset + 26) + u16(data, localOffset + 28);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > data.length) {
      throw new Error("invalid_zip");
    }
    const compressed = data.subarray(dataStart, dataEnd);

    if (compression === 0) {
      actualTotal += compressed.length;
      if (actualTotal > maxBytes) {
        throw new ZipBoundsError();
      }
      files[name] = compressed.slice();
      continue;
    }
    if (compression !== 8) {
      throw new ZipBoundsError("unsupported_compression");
    }
    const chunks: Uint8Array[] = [];
    let produced = 0;
    const inflater = new Inflate((chunk) => {
      actualTotal += chunk.length;
      if (actualTotal > maxBytes) {
        throw new ZipBoundsError();
      }
      produced += chunk.length;
      chunks.push(chunk);
    });
    for (let at = 0; at < compressed.length; at += inflateSliceBytes) {
      const sliceEnd = Math.min(at + inflateSliceBytes, compressed.length);
      inflater.push(compressed.subarray(at, sliceEnd), sliceEnd === compressed.length);
    }
    if (compressed.length === 0) {
      inflater.push(new Uint8Array(0), true);
    }
    const out = new Uint8Array(produced);
    let written = 0;
    for (const chunk of chunks) {
      out.set(chunk, written);
      written += chunk.length;
    }
    files[name] = out;
  }
  return files;
}
