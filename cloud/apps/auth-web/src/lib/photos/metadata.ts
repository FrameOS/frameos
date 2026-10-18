// Location and camera metadata taken out of a photo before it is stored
// (docs/photos.md "POST /api/photos/upload"). A phone's JPEG carries where
// it was taken (EXIF GPS), the camera's serial number, timestamps, XMP and
// sometimes a whole "motion photo" video after the picture; a share link
// would hand all of it to anyone who has the link. The scan sees the bytes
// as they came (the hash list holds hashes of known files); everything after
// it (thumbnail, size, the stored object) sees the result of this.
//
// Lossless and byte-level: no pixel is decoded or re-encoded, segments and
// chunks are dropped or kept as they are.
//
// - JPEG: APP0 (JFIF), APP2 ICC_PROFILE, APP14 Adobe and every structural
//   segment stay; APP1 (EXIF, XMP), the other APPn, COM and everything after
//   the primary image's EOI (MPF images, motion-photo videos) go.
// - PNG: eXIf, tEXt, zTXt, iTXt and tIME go, and whatever follows IEND.
// - WebP: the EXIF and XMP chunks go, the RIFF size and the VP8X flags follow.
// - GIF and anything else: untouched.
//
// An EXIF orientation other than 1 survives as a minimal EXIF block (one
// IFD0 entry, big-endian), so the photo still shows upright everywhere.
// A file whose structure cannot be followed is stored as it came (never
// worse than before this existed) and the caller logs it.
//
// The backend's app/utils/photo_metadata.py is the same procedure, rule for
// rule: both planes replay docs/photo-metadata-fixtures.json and must write
// byte-identical files. Change one, change both, re-record the corpus.
//
// The photo is read at offsets (segment lengths skip payloads unread, entropy
// data is scanned in chunks) and the result written range by range, so a
// 250 MiB upload on disk is never one buffer.

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { tiffOrientation } from "./image-info";

export type PhotoMetadataFormat = "jpeg" | "png" | "webp";

/** A photo on disk: a finished chunked upload. */
export type PhotoFile = { path: string; size: number };

export type StrippedPhoto = {
  /** What to store: the input itself when nothing had to go. */
  body: Buffer | PhotoFile;
  changed: boolean;
  format: PhotoMetadataFormat | null;
  /** Why a JPEG, PNG or WebP was kept as it came (it could not be parsed). */
  problem: string | null;
  /** SHA-256 of `body` when it changed (the caller has the input's). */
  sha256: string | null;
  size: number;
};

type Reader = { size: number; read(offset: number, length: number): Promise<Buffer> };

/** A stretch of the input kept as it is, or bytes written in its place. */
type Piece = { end: number; start: number } | Buffer;

type Plan =
  | { format: PhotoMetadataFormat | null; pieces: null; problem: string | null }
  | { format: PhotoMetadataFormat; pieces: Piece[]; problem: null };

// The most of an EXIF block read for its orientation: what a JPEG's APP1
// segment can hold. IFD0 sits at its start in every camera's file.
const maxExifBytes = 65536;
const windowBytes = 64 * 1024;
const scanChunkBytes = 1024 * 1024;
const copyChunkBytes = 1024 * 1024;

const exifHeader = Buffer.from("Exif\0\0", "latin1");
const iccHeader = Buffer.from("ICC_PROFILE\0", "latin1");
const adobeHeader = Buffer.from("Adobe", "latin1");
const pngSignature = Buffer.from("\x89PNG\r\n\x1a\n", "latin1");
const droppedPngChunks = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
const webpExifFlag = 0x08;
const webpXmpFlag = 0x04;

/**
 * The smallest EXIF that still turns the photo: a big-endian TIFF whose IFD0
 * holds one entry, Orientation (0x0112) SHORT 1 = `orientation`, and no next
 * IFD. Browsers, sharp, Pillow and the frames' pixie all read it.
 */
export function minimalExifTiff(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  // A SHORT sits in the first two bytes of the four-byte value field; the
  // next-IFD offset (22-25) stays zero.
  tiff.writeUInt16BE(orientation, 18);
  return tiff;
}

function minimalJpegApp1(orientation: number) {
  const payload = Buffer.concat([exifHeader, minimalExifTiff(orientation)]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function minimalPngExif(orientation: number) {
  const body = Buffer.concat([Buffer.from("eXIf", "latin1"), minimalExifTiff(orientation)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length - 4, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function minimalWebpExif(orientation: number) {
  const tiff = minimalExifTiff(orientation);
  const head = Buffer.alloc(8);
  head.write("EXIF", 0, "latin1");
  head.writeUInt32LE(tiff.length, 4);
  return Buffer.concat([head, tiff]);
}

/** An EXIF chunk's payload: a bare TIFF, or (some writers) "Exif\0\0" first. */
function chunkOrientation(block: Buffer) {
  return tiffOrientation(startsWith(block, exifHeader) ? block.subarray(6) : block);
}

function startsWith(bytes: Buffer, prefix: Buffer) {
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
}

/** Single bytes through a window, so walking segment headers is not a read each. */
class Source {
  private window: Buffer = Buffer.alloc(0);
  private windowStart = 0;

  constructor(private readonly reader: Reader) {}

  get size() {
    return this.reader.size;
  }

  async byte(offset: number): Promise<number | undefined> {
    if (offset < 0 || offset >= this.size) {
      return undefined;
    }
    if (offset < this.windowStart || offset >= this.windowStart + this.window.length) {
      this.window = await this.reader.read(offset, Math.min(windowBytes, this.size - offset));
      this.windowStart = offset;
    }
    return this.window[offset - this.windowStart];
  }

  /** Up to `length` bytes at `offset`: fewer at the end of the file. */
  read(offset: number, length: number): Promise<Buffer> {
    const available = Math.max(0, Math.min(length, this.size - offset));
    return available === 0 ? Promise.resolve(Buffer.alloc(0)) : this.reader.read(offset, available);
  }
}

class Pieces {
  readonly list: Piece[] = [];

  keep(start: number, end: number) {
    if (end <= start) {
      return;
    }
    const last = this.list.at(-1);
    if (last && !Buffer.isBuffer(last) && last.end === start) {
      last.end = end;
    } else {
      this.list.push({ end, start });
    }
  }

  add(bytes: Buffer) {
    this.list.push(bytes);
  }

  isWhole(size: number) {
    const [only] = this.list;
    return this.list.length === 1 && only !== undefined && !Buffer.isBuffer(only) && only.start === 0 && only.end === size;
  }
}

function malformed(format: PhotoMetadataFormat, problem: string): Plan {
  return { format, pieces: null, problem };
}

function untouched(format: PhotoMetadataFormat | null): Plan {
  return { format, pieces: null, problem: null };
}

/**
 * Where the entropy-coded data that starts at `from` ends: the 0xff of the
 * next marker (fill bytes included), or the end of the file. In the data a
 * 0xff is followed by 0x00 (a stuffed byte) or a restart marker.
 */
async function entropyEnd(source: Source, from: number): Promise<number> {
  let pos = from;
  while (pos < source.size) {
    const chunk = await source.read(pos, scanChunkBytes);
    let at = chunk.indexOf(0xff);
    while (at !== -1 && at + 1 < chunk.length) {
      const next = chunk[at + 1]!;
      if (next !== 0x00 && (next < 0xd0 || next > 0xd7)) {
        return pos + at;
      }
      at = chunk.indexOf(0xff, at + 2);
    }
    if (at === -1) {
      pos += chunk.length;
    } else if (pos + chunk.length >= source.size) {
      // A 0xff that is the file's last byte.
      return source.size;
    } else {
      // The byte after this 0xff is in the next read.
      pos += at;
    }
  }
  return source.size;
}

async function planJpeg(source: Source): Promise<Plan> {
  const { size } = source;
  const pieces = new Pieces();
  pieces.keep(0, 2);
  // The minimal APP1 goes after SOI and the APP0 segments right behind it.
  let insertAt = 2;
  let leading = true;
  let exifSeen = false;
  let orientation: number | undefined;
  let scanned = false;
  let pos = 2;
  while (pos < size) {
    const start = pos;
    if ((await source.byte(pos)) !== 0xff) {
      return malformed("jpeg", `no marker at byte ${pos}`);
    }
    // Any number of 0xff fill bytes may precede a marker.
    let at = pos + 1;
    while ((await source.byte(at)) === 0xff) {
      at += 1;
    }
    const marker = await source.byte(at);
    if (marker === undefined) {
      pieces.keep(start, size);
      break;
    }
    if (marker === 0x00) {
      return malformed("jpeg", `no marker at byte ${pos}`);
    }
    if (marker === 0xd9) {
      // The primary image's end: whatever follows (MPF images, a motion
      // photo's video) goes with the rest of the metadata.
      pieces.keep(start, at + 1);
      break;
    }
    // Standalone markers have no length: TEM, RST0-7, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      pieces.keep(start, at + 1);
      leading = false;
      pos = at + 1;
      continue;
    }
    if (at + 3 > size) {
      pieces.keep(start, size);
      break;
    }
    const length = ((await source.byte(at + 1))! << 8) | (await source.byte(at + 2))!;
    if (length < 2) {
      return malformed("jpeg", `segment length ${length} at byte ${pos}`);
    }
    const payload = at + 3;
    const end = at + 1 + length;
    const stop = Math.min(end, size);
    let kept: boolean;
    if (marker === 0xe1) {
      kept = false;
      if (!exifSeen && !scanned) {
        const head = await source.read(payload, stop - payload);
        if (startsWith(head, exifHeader)) {
          exifSeen = true;
          orientation = tiffOrientation(head.subarray(6));
        }
      }
    } else if (marker === 0xe2) {
      kept = startsWith(await source.read(payload, iccHeader.length), iccHeader);
    } else if (marker === 0xee) {
      kept = startsWith(await source.read(payload, adobeHeader.length), adobeHeader);
    } else if ((marker >= 0xe3 && marker <= 0xef) || marker === 0xfe) {
      kept = false;
    } else {
      // APP0 and every structural segment: tables, frame, scan headers.
      kept = true;
    }
    if (kept) {
      pieces.keep(start, stop);
    }
    if (leading) {
      if (marker === 0xe0) {
        insertAt = stop;
      } else {
        leading = false;
      }
    }
    if (end > size) {
      break;
    }
    pos = end;
    if (marker === 0xda) {
      // The scan's entropy-coded data, up to the next marker: more tables
      // and scans in a progressive JPEG, or EOI.
      scanned = true;
      const next = await entropyEnd(source, pos);
      pieces.keep(pos, next);
      pos = next;
    }
  }

  if (orientation !== undefined && orientation !== 1) {
    // [0, insertAt) is SOI and kept APP0s, all inside the first range.
    const first = pieces.list[0] as { end: number; start: number };
    const rest = pieces.list.slice(1);
    pieces.list.length = 0;
    pieces.keep(0, insertAt);
    pieces.add(minimalJpegApp1(orientation));
    pieces.keep(insertAt, first.end);
    pieces.list.push(...rest);
  }
  return pieces.isWhole(size) ? untouched("jpeg") : { format: "jpeg", pieces: pieces.list, problem: null };
}

async function planPng(source: Source): Promise<Plan> {
  const { size } = source;
  const pieces = new Pieces();
  pieces.keep(0, 8);
  let exifSeen = false;
  let pos = 8;
  while (pos < size) {
    if (pos + 8 > size) {
      pieces.keep(pos, size);
      break;
    }
    const head = await source.read(pos, 8);
    const length = head.readUInt32BE(0);
    if (length > 0x7fffffff) {
      return malformed("png", `chunk length ${length} at byte ${pos}`);
    }
    const type = head.toString("latin1", 4, 8);
    const end = pos + 12 + length;
    const stop = Math.min(end, size);
    if (type === "eXIf" && !exifSeen) {
      exifSeen = true;
      const orientation = chunkOrientation(await source.read(pos + 8, Math.min(length, maxExifBytes)));
      if (orientation !== undefined && orientation !== 1) {
        // In the place of the one it replaces.
        pieces.add(minimalPngExif(orientation));
      }
    }
    if (!droppedPngChunks.has(type)) {
      pieces.keep(pos, stop);
    }
    if (end > size || type === "IEND") {
      break;
    }
    pos = end;
  }
  return pieces.isWhole(size) ? untouched("png") : { format: "png", pieces: pieces.list, problem: null };
}

async function planWebp(source: Source): Promise<Plan> {
  const { size } = source;
  const header = await source.read(0, 12);
  const riffSize = header.readUInt32LE(4);
  if (riffSize < 4) {
    return malformed("webp", `RIFF size ${riffSize}`);
  }
  // Bytes after the RIFF's own end are not part of the image.
  const riffEnd = Math.min(8 + riffSize, size);
  const pieces = new Pieces();
  // VP8X's flags byte, held as a placeholder until the end decides it.
  const flagsPlaceholder = Buffer.alloc(1);
  let flags: { at: number; value: number } | undefined;
  let exifSeen = false;
  let exifKept = false;
  let pos = 12;
  while (pos < riffEnd) {
    if (pos + 8 > riffEnd) {
      pieces.keep(pos, riffEnd);
      break;
    }
    const head = await source.read(pos, 8);
    const fourcc = head.toString("latin1", 0, 4);
    const length = head.readUInt32LE(4);
    // Chunks are padded to an even size.
    const end = pos + 8 + length + (length % 2);
    const stop = Math.min(end, riffEnd);
    if (fourcc === "EXIF") {
      if (!exifSeen) {
        exifSeen = true;
        const orientation = chunkOrientation(await source.read(pos + 8, Math.min(length, maxExifBytes)));
        if (orientation !== undefined && orientation !== 1) {
          pieces.add(minimalWebpExif(orientation));
          exifKept = true;
        }
      }
    } else if (fourcc === "XMP ") {
      // Dropped.
    } else if (fourcc === "VP8X" && pos === 12 && stop - pos >= 9) {
      pieces.keep(pos, pos + 8);
      flags = { at: pos + 8, value: (await source.byte(pos + 8)) ?? 0 };
      pieces.add(flagsPlaceholder);
      pieces.keep(pos + 9, stop);
    } else {
      pieces.keep(pos, stop);
    }
    if (end > riffEnd) {
      break;
    }
    pos = end;
  }

  const written = pieces.list.reduce(
    (total, piece) => total + (Buffer.isBuffer(piece) ? piece.length : piece.end - piece.start),
    0,
  );
  // The RIFF size moves by what was taken out or put in, so a file whose
  // size was off before is off by the same amount after.
  const newRiffSize = riffSize + written - (riffEnd - 12);
  if (newRiffSize > 0xffffffff) {
    return malformed("webp", `RIFF size ${riffSize}`);
  }
  const result = new Pieces();
  if (newRiffSize === riffSize) {
    result.keep(0, 12);
  } else {
    const rebuiltHeader = Buffer.from(header);
    rebuiltHeader.writeUInt32LE(newRiffSize, 4);
    result.add(rebuiltHeader);
  }
  for (const piece of pieces.list) {
    if (piece === flagsPlaceholder && flags) {
      // No XMP any more; EXIF only when the minimal block stayed.
      const value = flags.value & ~webpXmpFlag & (exifKept ? 0xff : ~webpExifFlag);
      // The same byte stays a range, so an untouched file stays whole.
      if (value === flags.value) {
        result.keep(flags.at, flags.at + 1);
      } else {
        result.add(Buffer.from([value]));
      }
    } else if (Buffer.isBuffer(piece)) {
      result.add(piece);
    } else {
      result.keep(piece.start, piece.end);
    }
  }
  return result.isWhole(size) ? untouched("webp") : { format: "webp", pieces: result.list, problem: null };
}

async function plan(reader: Reader): Promise<Plan> {
  const source = new Source(reader);
  // The sniff the upload route's detectImageContentType does.
  if (source.size < 12) {
    return untouched(null);
  }
  const head = await source.read(0, 12);
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return planJpeg(source);
  }
  if (startsWith(head, pngSignature)) {
    return planPng(source);
  }
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
    return planWebp(source);
  }
  return untouched(null);
}

function bufferReader(bytes: Buffer): Reader {
  return {
    read: async (offset, length) => bytes.subarray(offset, offset + length),
    size: bytes.length,
  };
}

/** The photo without its metadata, from bytes in memory. */
export async function stripPhotoMetadataBytes(bytes: Buffer): Promise<StrippedPhoto> {
  const planned = await plan(bufferReader(bytes));
  if (!planned.pieces) {
    return { body: bytes, changed: false, format: planned.format, problem: planned.problem, sha256: null, size: bytes.length };
  }
  const body = Buffer.concat(
    planned.pieces.map((piece) => (Buffer.isBuffer(piece) ? piece : bytes.subarray(piece.start, piece.end))),
  );
  return {
    body,
    changed: true,
    format: planned.format,
    problem: null,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: body.length,
  };
}

/**
 * The photo without its metadata, from a file on disk. A changed photo is
 * written to `outputPath` (the caller removes it); an unchanged one is the
 * input file itself.
 */
export async function stripPhotoMetadataFile(file: PhotoFile, outputPath: string): Promise<StrippedPhoto> {
  const input = await open(file.path, "r");
  try {
    const reader: Reader = {
      read: async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await input.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
      },
      size: file.size,
    };
    const planned = await plan(reader);
    if (!planned.pieces) {
      return { body: file, changed: false, format: planned.format, problem: planned.problem, sha256: null, size: file.size };
    }
    const hash = createHash("sha256");
    let size = 0;
    const output = await open(outputPath, "w");
    try {
      const write = async (bytes: Buffer) => {
        await output.write(bytes);
        hash.update(bytes);
        size += bytes.length;
      };
      for (const piece of planned.pieces) {
        if (Buffer.isBuffer(piece)) {
          await write(piece);
          continue;
        }
        for (let at = piece.start; at < piece.end; at += copyChunkBytes) {
          await write(await reader.read(at, Math.min(copyChunkBytes, piece.end - at)));
        }
      }
    } finally {
      await output.close();
    }
    return {
      body: { path: outputPath, size },
      changed: true,
      format: planned.format,
      problem: null,
      sha256: hash.digest("hex"),
      size,
    };
  } finally {
    await input.close();
  }
}
