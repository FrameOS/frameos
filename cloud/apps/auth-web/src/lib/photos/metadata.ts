// What a photo carries besides its pixels, and the two removals its owner
// can ask for (docs/photos.md "Metadata", POST /api/photos/metadata).
// Uploads are stored exactly as sent: the library reads the metadata to
// inform (a location pin, the viewer's Info panel) and rewrites a photo only
// when asked.
//
// - The read: every EXIF field by group, the location (EXIF GPS, else XMP
//   exif:GPS*), PNG text chunks, and which other blocks the file holds
//   (XMP, IPTC, comments, text, a trailer such as a motion photo's video).
// - `remove: "location"`: the EXIF GPS IFD is cut out of IFD0 and its bytes
//   zeroed, XMP GPS properties are blanked with spaces. In place: the file
//   keeps its length and every other byte (a changed PNG chunk gets its
//   CRC again).
// - `remove: "all"`: lossless and byte-level, no pixel re-encoded. JPEG:
//   APP0 (JFIF), APP2 ICC_PROFILE, APP14 Adobe and every structural segment
//   stay; APP1 (EXIF, XMP), the other APPn, COM and everything after the
//   primary image's EOI go. PNG: eXIf, tEXt, zTXt, iTXt and tIME go, and
//   whatever follows IEND. WebP: the EXIF and XMP chunks go, the RIFF size
//   and the VP8X flags follow. An EXIF orientation other than 1 survives as
//   a minimal EXIF block (one IFD0 entry, big-endian).
// - GIF and anything else: nothing read, nothing changed.
//
// A JPEG, PNG or WebP whose structure cannot be followed to the end is read
// as far as it goes; "all" leaves it as it is (its `problem` says why),
// "location" still edits the blocks found before the problem.
//
// The backend's app/utils/photo_metadata.py is the same procedure, rule for
// rule: both planes replay docs/photo-metadata-fixtures.json and must give
// the same metadata and write byte-identical files. Change one, change both,
// re-record the corpus (tools/generate_photo_metadata_fixtures.py).
//
// The photo is read at offsets (segment lengths skip payloads unread, entropy
// data is scanned in chunks) and a rewrite is written range by range, so a
// 250 MiB photo on disk is never one buffer.

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { tiffOrientation } from "./image-info";

export type PhotoMetadataFormat = "jpeg" | "png" | "webp";

/** A photo on disk: a finished chunked upload, a downloaded object. */
export type PhotoFile = { path: string; size: number };

export type PhotoLocation = { altitude: number | null; latitude: number; longitude: number };

export type PhotoMetadataValue = string | number | null | (number | null)[];

export type PhotoMetadataField = { group: string; name: string; value: PhotoMetadataValue };

export type PhotoMetadataBlock = "exif" | "xmp" | "iptc" | "comment" | "text" | "trailer" | "other";

export type PhotoMetadata = {
  blocks: PhotoMetadataBlock[];
  fields: PhotoMetadataField[];
  location: PhotoLocation | null;
};

export type PhotoMetadataRemoval = "location" | "all";

export type RewrittenPhoto = {
  /** What to store: the input itself when nothing changed. */
  body: Buffer | PhotoFile;
  changed: boolean;
  format: PhotoMetadataFormat | null;
  /** Why a JPEG, PNG or WebP could not be followed to its end. */
  problem: string | null;
  /** SHA-256 of `body` when it changed (the caller has the input's). */
  sha256: string | null;
  size: number;
};

export function emptyPhotoMetadata(): PhotoMetadata {
  return { blocks: [], fields: [], location: null };
}

type Reader = { size: number; read(offset: number, length: number): Promise<Buffer> };

/** A stretch of the input kept as it is, or bytes written in its place. */
type Piece = { end: number; start: number } | Buffer;

type Region = { length: number; start: number };

/** An EXIF or XMP block, and the PNG chunk data it lies in (its CRC follows). */
type Block = Region & { chunk: Region | null };

/** One walk over the file: what every reader and remover here works from. */
type Survey = {
  /** The "remove all" result; null when it changes nothing or cannot run. */
  all: Piece[] | null;
  blocks: Set<PhotoMetadataBlock>;
  /** The TIFF bytes of the first EXIF block. */
  exif: Block | null;
  exifBlocks: number;
  format: PhotoMetadataFormat | null;
  problem: string | null;
  texts: { data: Region; type: string }[];
  /** Uncompressed XMP packets, in file order. */
  xmp: Block[];
};

// The most of an EXIF block read for its orientation by "remove all": what
// a JPEG's APP1 segment can hold. IFD0 sits at its start in every camera's
// file.
const maxExifBytes = 65536;
// The most of one EXIF or XMP block read, or rewritten, by the reader and
// "remove location".
const maxBlockBytes = 16 * 1024 * 1024;
// The most of a PNG text chunk read for its field.
const maxTextBytes = 65536;
const maxFields = 500;
const maxStringLength = 256;
const windowBytes = 64 * 1024;
const scanChunkBytes = 1024 * 1024;
const copyChunkBytes = 1024 * 1024;

const exifHeader = Buffer.from("Exif\0\0", "latin1");
const xmpHeader = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1");
const xmpExtensionHeader = Buffer.from("http://ns.adobe.com/xmp/extension/\0", "latin1");
// The extension's namespace, then a 32-byte GUID, the full length and this
// part's offset.
const xmpExtensionSkip = xmpExtensionHeader.length + 32 + 4 + 4;
const iccHeader = Buffer.from("ICC_PROFILE\0", "latin1");
const adobeHeader = Buffer.from("Adobe", "latin1");
const userCommentAscii = Buffer.from("ASCII\0\0\0", "latin1");
const pngSignature = Buffer.from("\x89PNG\r\n\x1a\n", "latin1");
const droppedPngChunks = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
const xmpKeyword = "XML:com.adobe.xmp";
const webpExifFlag = 0x08;
const webpXmpFlag = 0x04;
const blockOrder: PhotoMetadataBlock[] = ["exif", "xmp", "iptc", "comment", "text", "trailer", "other"];

const pointerTags = new Set([0x8769, 0x8825, 0xa005]);

// Tag names (EXIF 2.32, TIFF 6, the GPS IFD), the names exiv2 gives them.
// The backend's photo_metadata.py carries the same three tables; its test
// compares them with these.
const mainTagNames = new Map<number, string>([
  [0x000b, "ProcessingSoftware"],
  [0x00fe, "NewSubfileType"],
  [0x00ff, "SubfileType"],
  [0x0100, "ImageWidth"],
  [0x0101, "ImageLength"],
  [0x0102, "BitsPerSample"],
  [0x0103, "Compression"],
  [0x0106, "PhotometricInterpretation"],
  [0x010d, "DocumentName"],
  [0x010e, "ImageDescription"],
  [0x010f, "Make"],
  [0x0110, "Model"],
  [0x0111, "StripOffsets"],
  [0x0112, "Orientation"],
  [0x0115, "SamplesPerPixel"],
  [0x0116, "RowsPerStrip"],
  [0x0117, "StripByteCounts"],
  [0x011a, "XResolution"],
  [0x011b, "YResolution"],
  [0x011c, "PlanarConfiguration"],
  [0x0128, "ResolutionUnit"],
  [0x012d, "TransferFunction"],
  [0x0131, "Software"],
  [0x0132, "DateTime"],
  [0x013b, "Artist"],
  [0x013c, "HostComputer"],
  [0x013e, "WhitePoint"],
  [0x013f, "PrimaryChromaticities"],
  [0x0201, "JPEGInterchangeFormat"],
  [0x0202, "JPEGInterchangeFormatLength"],
  [0x0211, "YCbCrCoefficients"],
  [0x0212, "YCbCrSubSampling"],
  [0x0213, "YCbCrPositioning"],
  [0x0214, "ReferenceBlackWhite"],
  [0x02bc, "XMLPacket"],
  [0x4746, "Rating"],
  [0x4749, "RatingPercent"],
  [0x8298, "Copyright"],
  [0x829a, "ExposureTime"],
  [0x829d, "FNumber"],
  [0x83bb, "IPTCNAA"],
  [0x8773, "InterColorProfile"],
  [0x8822, "ExposureProgram"],
  [0x8824, "SpectralSensitivity"],
  [0x8827, "ISOSpeedRatings"],
  [0x8828, "OECF"],
  [0x8830, "SensitivityType"],
  [0x8831, "StandardOutputSensitivity"],
  [0x8832, "RecommendedExposureIndex"],
  [0x8833, "ISOSpeed"],
  [0x8834, "ISOSpeedLatitudeyyy"],
  [0x8835, "ISOSpeedLatitudezzz"],
  [0x9000, "ExifVersion"],
  [0x9003, "DateTimeOriginal"],
  [0x9004, "DateTimeDigitized"],
  [0x9010, "OffsetTime"],
  [0x9011, "OffsetTimeOriginal"],
  [0x9012, "OffsetTimeDigitized"],
  [0x9101, "ComponentsConfiguration"],
  [0x9102, "CompressedBitsPerPixel"],
  [0x9201, "ShutterSpeedValue"],
  [0x9202, "ApertureValue"],
  [0x9203, "BrightnessValue"],
  [0x9204, "ExposureBiasValue"],
  [0x9205, "MaxApertureValue"],
  [0x9206, "SubjectDistance"],
  [0x9207, "MeteringMode"],
  [0x9208, "LightSource"],
  [0x9209, "Flash"],
  [0x920a, "FocalLength"],
  [0x9214, "SubjectArea"],
  [0x927c, "MakerNote"],
  [0x9286, "UserComment"],
  [0x9290, "SubSecTime"],
  [0x9291, "SubSecTimeOriginal"],
  [0x9292, "SubSecTimeDigitized"],
  [0x9400, "Temperature"],
  [0x9401, "Humidity"],
  [0x9402, "Pressure"],
  [0x9403, "WaterDepth"],
  [0x9404, "Acceleration"],
  [0x9405, "CameraElevationAngle"],
  [0x9c9b, "XPTitle"],
  [0x9c9c, "XPComment"],
  [0x9c9d, "XPAuthor"],
  [0x9c9e, "XPKeywords"],
  [0x9c9f, "XPSubject"],
  [0xa000, "FlashpixVersion"],
  [0xa001, "ColorSpace"],
  [0xa002, "PixelXDimension"],
  [0xa003, "PixelYDimension"],
  [0xa004, "RelatedSoundFile"],
  [0xa20b, "FlashEnergy"],
  [0xa20c, "SpatialFrequencyResponse"],
  [0xa20e, "FocalPlaneXResolution"],
  [0xa20f, "FocalPlaneYResolution"],
  [0xa210, "FocalPlaneResolutionUnit"],
  [0xa214, "SubjectLocation"],
  [0xa215, "ExposureIndex"],
  [0xa217, "SensingMethod"],
  [0xa300, "FileSource"],
  [0xa301, "SceneType"],
  [0xa302, "CFAPattern"],
  [0xa401, "CustomRendered"],
  [0xa402, "ExposureMode"],
  [0xa403, "WhiteBalance"],
  [0xa404, "DigitalZoomRatio"],
  [0xa405, "FocalLengthIn35mmFilm"],
  [0xa406, "SceneCaptureType"],
  [0xa407, "GainControl"],
  [0xa408, "Contrast"],
  [0xa409, "Saturation"],
  [0xa40a, "Sharpness"],
  [0xa40b, "DeviceSettingDescription"],
  [0xa40c, "SubjectDistanceRange"],
  [0xa420, "ImageUniqueID"],
  [0xa430, "CameraOwnerName"],
  [0xa431, "BodySerialNumber"],
  [0xa432, "LensSpecification"],
  [0xa433, "LensMake"],
  [0xa434, "LensModel"],
  [0xa435, "LensSerialNumber"],
  [0xa460, "CompositeImage"],
  [0xa461, "SourceImageNumberOfCompositeImage"],
  [0xa462, "SourceExposureTimesOfCompositeImage"],
  [0xa500, "Gamma"],
  [0xc4a5, "PrintImageMatching"],
  [0xea1c, "Padding"],
]);

const gpsTagNames = new Map<number, string>([
  [0x0000, "GPSVersionID"],
  [0x0001, "GPSLatitudeRef"],
  [0x0002, "GPSLatitude"],
  [0x0003, "GPSLongitudeRef"],
  [0x0004, "GPSLongitude"],
  [0x0005, "GPSAltitudeRef"],
  [0x0006, "GPSAltitude"],
  [0x0007, "GPSTimeStamp"],
  [0x0008, "GPSSatellites"],
  [0x0009, "GPSStatus"],
  [0x000a, "GPSMeasureMode"],
  [0x000b, "GPSDOP"],
  [0x000c, "GPSSpeedRef"],
  [0x000d, "GPSSpeed"],
  [0x000e, "GPSTrackRef"],
  [0x000f, "GPSTrack"],
  [0x0010, "GPSImgDirectionRef"],
  [0x0011, "GPSImgDirection"],
  [0x0012, "GPSMapDatum"],
  [0x0013, "GPSDestLatitudeRef"],
  [0x0014, "GPSDestLatitude"],
  [0x0015, "GPSDestLongitudeRef"],
  [0x0016, "GPSDestLongitude"],
  [0x0017, "GPSDestBearingRef"],
  [0x0018, "GPSDestBearing"],
  [0x0019, "GPSDestDistanceRef"],
  [0x001a, "GPSDestDistance"],
  [0x001b, "GPSProcessingMethod"],
  [0x001c, "GPSAreaInformation"],
  [0x001d, "GPSDateStamp"],
  [0x001e, "GPSDifferential"],
  [0x001f, "GPSHPositioningError"],
]);

const interopTagNames = new Map<number, string>([
  [0x0001, "InteroperabilityIndex"],
  [0x0002, "InteroperabilityVersion"],
  [0x1000, "RelatedImageFileFormat"],
  [0x1001, "RelatedImageWidth"],
  [0x1002, "RelatedImageLength"],
]);

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

function newSurvey(format: PhotoMetadataFormat | null): Survey {
  return { all: null, blocks: new Set(), exif: null, exifBlocks: 0, format, problem: null, texts: [], xmp: [] };
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

async function surveyJpeg(source: Source): Promise<Survey> {
  const { size } = source;
  const survey = newSurvey("jpeg");
  const pieces = new Pieces();
  pieces.keep(0, 2);
  // The minimal APP1 goes after SOI and the APP0 segments right behind it.
  let insertAt = 2;
  let leading = true;
  let orientation: number | undefined;
  let scanned = false;
  let pos = 2;
  while (pos < size) {
    const start = pos;
    if ((await source.byte(pos)) !== 0xff) {
      survey.problem = `no marker at byte ${pos}`;
      return survey;
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
      survey.problem = `no marker at byte ${pos}`;
      return survey;
    }
    if (marker === 0xd9) {
      // The primary image's end: whatever follows (MPF images, a motion
      // photo's video) is a trailer.
      pieces.keep(start, at + 1);
      if (at + 1 < size) {
        survey.blocks.add("trailer");
      }
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
      survey.problem = `segment length ${length} at byte ${pos}`;
      return survey;
    }
    const payload = at + 3;
    const end = at + 1 + length;
    const stop = Math.min(end, size);
    let kept: boolean;
    if (marker === 0xe1) {
      kept = false;
      const head = await source.read(payload, stop - payload);
      if (startsWith(head, exifHeader)) {
        survey.blocks.add("exif");
        survey.exifBlocks += 1;
        if (!survey.exif && !scanned) {
          survey.exif = { chunk: null, length: stop - payload - 6, start: payload + 6 };
          orientation = tiffOrientation(head.subarray(6));
        }
      } else if (startsWith(head, xmpHeader)) {
        survey.blocks.add("xmp");
        survey.xmp.push({ chunk: null, length: stop - payload - xmpHeader.length, start: payload + xmpHeader.length });
      } else if (startsWith(head, xmpExtensionHeader)) {
        survey.blocks.add("xmp");
        if (stop - payload > xmpExtensionSkip) {
          survey.xmp.push({ chunk: null, length: stop - payload - xmpExtensionSkip, start: payload + xmpExtensionSkip });
        }
      } else {
        survey.blocks.add("other");
      }
    } else if (marker === 0xe2) {
      kept = startsWith(await source.read(payload, iccHeader.length), iccHeader);
    } else if (marker === 0xee) {
      kept = startsWith(await source.read(payload, adobeHeader.length), adobeHeader);
    } else if ((marker >= 0xe3 && marker <= 0xef) || marker === 0xfe) {
      kept = false;
      survey.blocks.add(marker === 0xed ? "iptc" : marker === 0xfe ? "comment" : "other");
    } else {
      // APP0 and every structural segment: tables, frame, scan headers.
      kept = true;
    }
    if (kept) {
      pieces.keep(start, stop);
    } else if (marker === 0xe2 || marker === 0xee) {
      survey.blocks.add("other");
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
  survey.all = pieces.isWhole(size) ? null : pieces.list;
  return survey;
}

async function surveyPng(source: Source): Promise<Survey> {
  const { size } = source;
  const survey = newSurvey("png");
  const pieces = new Pieces();
  pieces.keep(0, 8);
  let pos = 8;
  while (pos < size) {
    if (pos + 8 > size) {
      pieces.keep(pos, size);
      break;
    }
    const head = await source.read(pos, 8);
    const length = head.readUInt32BE(0);
    if (length > 0x7fffffff) {
      survey.problem = `chunk length ${length} at byte ${pos}`;
      return survey;
    }
    const type = head.toString("latin1", 4, 8);
    const end = pos + 12 + length;
    const stop = Math.min(end, size);
    const data: Region = { length: Math.min(length, size - pos - 8), start: pos + 8 };
    // A chunk the file cuts short has no CRC to keep right.
    const chunk = end <= size ? data : null;
    if (type === "eXIf") {
      survey.blocks.add("exif");
      survey.exifBlocks += 1;
      if (!survey.exif) {
        const head6 = await source.read(data.start, 6);
        const skip = startsWith(head6, exifHeader) ? 6 : 0;
        survey.exif = { chunk, length: Math.max(0, data.length - skip), start: data.start + skip };
        const orientation = chunkOrientation(await source.read(pos + 8, Math.min(length, maxExifBytes)));
        if (orientation !== undefined && orientation !== 1) {
          // In the place of the one it replaces.
          pieces.add(minimalPngExif(orientation));
        }
      }
    } else if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const text = await source.read(data.start, Math.min(data.length, maxTextBytes));
      const keywordEnd = text.indexOf(0);
      const keyword = text.toString("latin1", 0, keywordEnd < 0 ? text.length : keywordEnd);
      if (type === "iTXt" && keyword === xmpKeyword) {
        survey.blocks.add("xmp");
        const textAt = itxtTextOffset(text, keywordEnd);
        if (textAt !== undefined && text[keywordEnd + 1] === 0) {
          survey.xmp.push({ chunk, length: data.length - textAt, start: data.start + textAt });
        }
      } else {
        survey.blocks.add("text");
        survey.texts.push({ data, type });
      }
    } else if (type === "tIME") {
      survey.blocks.add("other");
    }
    if (!droppedPngChunks.has(type)) {
      pieces.keep(pos, stop);
    }
    if (end > size) {
      break;
    }
    pos = end;
    if (type === "IEND") {
      if (pos < size) {
        survey.blocks.add("trailer");
      }
      break;
    }
  }
  survey.all = pieces.isWhole(size) ? null : pieces.list;
  return survey;
}

/**
 * Where an iTXt chunk's text starts in its data: after the keyword's NUL,
 * the compression flag and method, and the NUL-ended language tag and
 * translated keyword. undefined when the chunk does not hold them.
 */
function itxtTextOffset(data: Buffer, keywordEnd: number): number | undefined {
  if (keywordEnd < 0 || keywordEnd + 3 > data.length) {
    return undefined;
  }
  const languageEnd = data.indexOf(0, keywordEnd + 3);
  const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
  return translatedEnd < 0 ? undefined : translatedEnd + 1;
}

async function surveyWebp(source: Source): Promise<Survey> {
  const { size } = source;
  const survey = newSurvey("webp");
  const header = await source.read(0, 12);
  const riffSize = header.readUInt32LE(4);
  if (riffSize < 4) {
    survey.problem = `RIFF size ${riffSize}`;
    return survey;
  }
  // Bytes after the RIFF's own end are not part of the image.
  const riffEnd = Math.min(8 + riffSize, size);
  if (8 + riffSize < size) {
    survey.blocks.add("trailer");
  }
  const pieces = new Pieces();
  // VP8X's flags byte, held as a placeholder until the end decides it.
  const flagsPlaceholder = Buffer.alloc(1);
  let flags: { at: number; value: number } | undefined;
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
    const data: Region = { length: Math.min(length, riffEnd - pos - 8), start: pos + 8 };
    if (fourcc === "EXIF") {
      survey.blocks.add("exif");
      survey.exifBlocks += 1;
      if (!survey.exif) {
        const head6 = await source.read(data.start, 6);
        const skip = startsWith(head6, exifHeader) ? 6 : 0;
        survey.exif = { chunk: null, length: Math.max(0, data.length - skip), start: data.start + skip };
        const orientation = chunkOrientation(await source.read(pos + 8, Math.min(length, maxExifBytes)));
        if (orientation !== undefined && orientation !== 1) {
          pieces.add(minimalWebpExif(orientation));
          exifKept = true;
        }
      }
    } else if (fourcc === "XMP ") {
      survey.blocks.add("xmp");
      survey.xmp.push({ chunk: null, ...data });
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
    survey.problem = `RIFF size ${riffSize}`;
    return survey;
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
  survey.all = result.isWhole(size) ? null : result.list;
  return survey;
}

async function surveyPhoto(source: Source): Promise<Survey> {
  // The sniff the upload route's detectImageContentType does.
  if (source.size < 12) {
    return newSurvey(null);
  }
  const head = await source.read(0, 12);
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return surveyJpeg(source);
  }
  if (startsWith(head, pngSignature)) {
    return surveyPng(source);
  }
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
    return surveyWebp(source);
  }
  return newSurvey(null);
}

// ---------------------------------------------------------------------------
// EXIF: the TIFF structure inside an EXIF block

type IfdEntry = { count: number; tag: number; type: number; valueAt: number };

const typeSizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

class Tiff {
  readonly little: boolean;

  constructor(readonly bytes: Buffer) {
    this.little = bytes.toString("latin1", 0, 2) === "II";
  }

  static open(bytes: Buffer): Tiff | undefined {
    if (bytes.length < 8) {
      return undefined;
    }
    const order = bytes.toString("latin1", 0, 2);
    if (order !== "II" && order !== "MM") {
      return undefined;
    }
    const tiff = new Tiff(bytes);
    return tiff.u16(2) === 42 ? tiff : undefined;
  }

  get length() {
    return this.bytes.length;
  }

  u16(at: number) {
    return this.little ? this.bytes.readUInt16LE(at) : this.bytes.readUInt16BE(at);
  }

  u32(at: number) {
    return this.little ? this.bytes.readUInt32LE(at) : this.bytes.readUInt32BE(at);
  }

  s16(at: number) {
    return this.little ? this.bytes.readInt16LE(at) : this.bytes.readInt16BE(at);
  }

  s32(at: number) {
    return this.little ? this.bytes.readInt32LE(at) : this.bytes.readInt32BE(at);
  }

  f32(at: number) {
    return this.little ? this.bytes.readFloatLE(at) : this.bytes.readFloatBE(at);
  }

  f64(at: number) {
    return this.little ? this.bytes.readDoubleLE(at) : this.bytes.readDoubleBE(at);
  }

  /** An IFD's entries (as many as the block holds) and the next IFD's offset. */
  ifd(offset: number): { entries: IfdEntry[]; next: number } | undefined {
    if (offset === 0 || offset + 2 > this.length) {
      return undefined;
    }
    const count = this.u16(offset);
    const entries: IfdEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      const at = offset + 2 + index * 12;
      if (at + 12 > this.length) {
        break;
      }
      entries.push({ count: this.u32(at + 4), tag: this.u16(at), type: this.u16(at + 2), valueAt: at + 8 });
    }
    const nextAt = offset + 2 + count * 12;
    return { entries, next: nextAt + 4 <= this.length ? this.u32(nextAt) : 0 };
  }

  /** Where an entry's value lies: in the entry when it fits, else at its offset. */
  valueOffset(entry: IfdEntry): number | undefined {
    const size = (typeSizes[entry.type] ?? 0) * entry.count;
    if (size <= 4) {
      return entry.valueAt;
    }
    const offset = this.u32(entry.valueAt);
    return offset + size <= this.length ? offset : undefined;
  }

  /** The IFD an entry points to (a LONG or IFD of count 1), or undefined. */
  pointer(entry: IfdEntry | undefined): number | undefined {
    if (!entry || (entry.type !== 4 && entry.type !== 13) || entry.count !== 1) {
      return undefined;
    }
    return this.u32(entry.valueAt);
  }

  number(type: number, at: number): number | null {
    switch (type) {
      case 1:
        return this.bytes[at]!;
      case 6:
        return this.bytes.readInt8(at);
      case 3:
        return this.u16(at);
      case 8:
        return this.s16(at);
      case 4:
        return this.u32(at);
      case 9:
        return this.s32(at);
      case 5:
        return ratio(this.u32(at), this.u32(at + 4));
      case 10:
        return ratio(this.s32(at), this.s32(at + 4));
      case 11:
        return finite(this.f32(at));
      default:
        return finite(this.f64(at));
    }
  }
}

function finite(value: number): number | null {
  // -0 is 0: JSON has no negative zero.
  return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : finite(numerator / denominator);
}

/** Cut to 256 characters (code points) and "…". */
function capped(text: string): string {
  const characters = Array.from(text);
  return characters.length > maxStringLength ? `${characters.slice(0, maxStringLength).join("")}…` : text;
}

const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** An ASCII value: to its first NUL, UTF-8 (bad bytes replaced), trailing whitespace off. */
function asciiString(bytes: Buffer, encoding: "utf8" | "latin1" = "utf8"): string {
  const end = bytes.indexOf(0);
  const text = end < 0 ? bytes : bytes.subarray(0, end);
  const decoded = encoding === "utf8" ? utf8.decode(text) : text.toString("latin1");
  return capped(decoded.replace(/[ \t\n\r\v\f]+$/, ""));
}

/** UNDEFINED bytes: text when every byte is printable ASCII, else their count. */
function undefinedValue(bytes: Buffer, count: number): string {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0x20)) {
    end -= 1;
  }
  for (let index = 0; index < end; index += 1) {
    const byte = bytes[index]!;
    if (byte < 0x20 || byte > 0x7e) {
      return `(${count} bytes)`;
    }
  }
  return capped(bytes.toString("latin1", 0, end));
}

/** An entry as the Metadata object shows it; undefined for one that is skipped. */
function fieldValue(tiff: Tiff, entry: IfdEntry): PhotoMetadataValue | undefined {
  const unit = typeSizes[entry.type];
  if (unit === undefined || entry.count === 0) {
    return undefined;
  }
  if (entry.tag === 0x927c) {
    return `(${entry.count * unit} bytes)`;
  }
  if (entry.type !== 2 && entry.type !== 7 && entry.count > 16) {
    return `(${entry.count} values)`;
  }
  const at = tiff.valueOffset(entry);
  if (at === undefined) {
    return undefined;
  }
  if (entry.type === 2) {
    return asciiString(tiff.bytes.subarray(at, at + entry.count));
  }
  if (entry.type === 7) {
    const bytes = tiff.bytes.subarray(at, at + entry.count);
    if (entry.tag === 0x9286 && startsWith(bytes, userCommentAscii)) {
      return asciiString(bytes.subarray(userCommentAscii.length));
    }
    return undefinedValue(bytes, entry.count);
  }
  const values: (number | null)[] = [];
  for (let index = 0; index < entry.count; index += 1) {
    values.push(tiff.number(entry.type, at + index * unit));
  }
  return entry.count === 1 ? values[0]! : values;
}

function tagName(table: Map<number, string>, tag: number) {
  return table.get(tag) ?? `Tag 0x${tag.toString(16).toUpperCase().padStart(4, "0")}`;
}

function validLocation(latitude: number | null, longitude: number | null) {
  return (
    latitude !== null &&
    longitude !== null &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    // What a camera without a fix writes.
    !(latitude === 0 && longitude === 0)
  );
}

/** Degrees, minutes, seconds (RATIONAL 1 to 3 of them) as decimal degrees. */
function gpsCoordinate(tiff: Tiff, entry: IfdEntry | undefined): number | null {
  if (!entry || entry.type !== 5 || entry.count < 1) {
    return null;
  }
  const at = tiff.valueOffset(entry);
  if (at === undefined) {
    return null;
  }
  const parts = [0, 0, 0];
  for (let index = 0; index < Math.min(entry.count, 3); index += 1) {
    const part = ratio(tiff.u32(at + index * 8), tiff.u32(at + index * 8 + 4));
    if (part === null) {
      return null;
    }
    parts[index] = part;
  }
  return finite(parts[0]! + parts[1]! / 60 + parts[2]! / 3600);
}

function gpsRef(tiff: Tiff, entry: IfdEntry | undefined): string {
  if (!entry || entry.type !== 2) {
    return "";
  }
  const at = tiff.valueOffset(entry);
  return at === undefined ? "" : asciiString(tiff.bytes.subarray(at, at + entry.count));
}

function signed(value: number, negative: boolean) {
  return negative && value !== 0 ? -value : value;
}

function gpsLocation(tiff: Tiff, entries: IfdEntry[]): PhotoLocation | null {
  const byTag = new Map<number, IfdEntry>();
  for (const entry of entries) {
    if (!byTag.has(entry.tag)) {
      byTag.set(entry.tag, entry);
    }
  }
  const latitude = gpsCoordinate(tiff, byTag.get(0x0002));
  const longitude = gpsCoordinate(tiff, byTag.get(0x0004));
  if (latitude === null || longitude === null) {
    return null;
  }
  const north = signed(latitude, gpsRef(tiff, byTag.get(0x0001)) === "S");
  const east = signed(longitude, gpsRef(tiff, byTag.get(0x0003)) === "W");
  if (!validLocation(north, east)) {
    return null;
  }
  let altitude: number | null = null;
  const altitudeEntry = byTag.get(0x0006);
  if (altitudeEntry && altitudeEntry.type === 5 && altitudeEntry.count >= 1) {
    const at = tiff.valueOffset(altitudeEntry);
    const value = at === undefined ? null : ratio(tiff.u32(at), tiff.u32(at + 4));
    if (value !== null) {
      const refEntry = byTag.get(0x0005);
      const refAt = refEntry && refEntry.type === 1 && refEntry.count >= 1 ? tiff.valueOffset(refEntry) : undefined;
      altitude = signed(value, refAt !== undefined && tiff.bytes[refAt] === 1);
    }
  }
  return { altitude, latitude: north, longitude: east };
}

type ExifRead = { fields: PhotoMetadataField[]; location: PhotoLocation | null; orientationOnly: boolean };

/** Every field of an EXIF block, by group, and its GPS location. */
export function readExif(bytes: Buffer): ExifRead {
  const tiff = Tiff.open(bytes);
  if (!tiff) {
    return { fields: [], location: null, orientationOnly: false };
  }
  const seen = new Set<number>();
  const ifdAt = (offset: number | undefined) => {
    if (offset === undefined || seen.has(offset)) {
      return undefined;
    }
    seen.add(offset);
    return tiff.ifd(offset);
  };
  const first = (entries: IfdEntry[] | undefined, tag: number) => entries?.find((entry) => entry.tag === tag);
  const image = ifdAt(tiff.u32(4));
  const photo = ifdAt(tiff.pointer(first(image?.entries, 0x8769)));
  const gps = ifdAt(tiff.pointer(first(image?.entries, 0x8825)));
  const interop = ifdAt(tiff.pointer(first(photo?.entries, 0xa005)));
  const thumbnail = ifdAt(image && image.next !== 0 ? image.next : undefined);
  const groups: [string, IfdEntry[] | undefined, Map<number, string>][] = [
    ["Image", image?.entries, mainTagNames],
    ["Photo", photo?.entries, mainTagNames],
    ["Location", gps?.entries, gpsTagNames],
    ["Interoperability", interop?.entries, interopTagNames],
    ["Thumbnail", thumbnail?.entries, mainTagNames],
  ];
  const fields: PhotoMetadataField[] = [];
  for (const [group, entries, table] of groups) {
    for (const entry of entries ?? []) {
      if (fields.length >= maxFields) {
        break;
      }
      if (pointerTags.has(entry.tag)) {
        continue;
      }
      const value = fieldValue(tiff, entry);
      if (value !== undefined) {
        fields.push({ group, name: tagName(table, entry.tag), value });
      }
    }
  }
  return {
    fields,
    location: gps ? gpsLocation(tiff, gps.entries) : null,
    orientationOnly:
      image !== undefined && image.entries.length === 1 && image.entries[0]!.tag === 0x0112 && image.next === 0,
  };
}

// ---------------------------------------------------------------------------
// XMP

const xmpCoordinate = /^[ \t\r\n]*([0-9]+),([0-9]+(?:\.[0-9]+)?)(?:,([0-9]+(?:\.[0-9]+)?))?([NSEW])[ \t\r\n]*$/;
// A hostile packet cannot make the scan slow: at most this many exif:GPS
// occurrences are looked at, and a property must end within this many
// characters of where it starts.
const maxXmpProperties = 4096;
const maxXmpPropertyLength = 65536;

type XmpProperty = { end: number; name: string; start: number; value: string | null };

function isXmpSpace(character: string | undefined) {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

function isXmpNameCharacter(character: string | undefined) {
  return character !== undefined && /^[A-Za-z0-9_]$/.test(character);
}

/**
 * Every exif:GPS* property of an XMP packet (read as Latin-1, so an index is
 * a byte offset), in order: an attribute `exif:GPSx="v"` or an element
 * `<exif:GPSx>v</exif:GPSx>` (`value` null when it holds markup or is
 * self-closing). The backend's _xmp_gps_properties, step for step.
 */
function xmpGpsProperties(text: string): XmpProperty[] {
  const properties: XmpProperty[] = [];
  let pos = 0;
  for (let looked = 0; looked < maxXmpProperties; looked += 1) {
    const at = text.indexOf("exif:GPS", pos);
    if (at < 0) {
      break;
    }
    pos = at + 1;
    let nameEnd = at + 8;
    while (isXmpNameCharacter(text[nameEnd])) {
      nameEnd += 1;
    }
    const name = text.slice(at + 5, nameEnd);
    const limit = Math.min(text.length, at + maxXmpPropertyLength);
    if (at > 0 && text[at - 1] === "<") {
      const following = text[nameEnd];
      if (following !== ">" && following !== "/" && !isXmpSpace(following)) {
        continue;
      }
      const tagEnd = text.slice(nameEnd, limit).indexOf(">");
      if (tagEnd < 0) {
        continue;
      }
      const contentStart = nameEnd + tagEnd + 1;
      if (text[contentStart - 2] === "/") {
        properties.push({ end: contentStart, name, start: at - 1, value: null });
        pos = contentStart;
        continue;
      }
      const close = `</exif:${name}`;
      let search = contentStart;
      let end = -1;
      let contentEnd = -1;
      while (search < limit) {
        const found = text.slice(search, limit).indexOf(close);
        if (found < 0) {
          break;
        }
        const closeAt = search + found;
        let after = closeAt + close.length;
        while (after < limit && isXmpSpace(text[after])) {
          after += 1;
        }
        if (after < limit && text[after] === ">") {
          end = after + 1;
          contentEnd = closeAt;
          break;
        }
        search = closeAt + 1;
      }
      if (end < 0) {
        continue;
      }
      const content = text.slice(contentStart, contentEnd);
      properties.push({ end, name, start: at - 1, value: content.includes("<") ? null : content });
      pos = end;
      continue;
    }
    let equals = nameEnd;
    while (isXmpSpace(text[equals])) {
      equals += 1;
    }
    if (text[equals] !== "=") {
      continue;
    }
    let quoteAt = equals + 1;
    while (isXmpSpace(text[quoteAt])) {
      quoteAt += 1;
    }
    const quote = text[quoteAt];
    if (quote !== '"' && quote !== "'") {
      continue;
    }
    const closing = text.slice(quoteAt + 1, limit).indexOf(quote);
    if (closing < 0) {
      continue;
    }
    const closeAt = quoteAt + 1 + closing;
    properties.push({ end: closeAt + 1, name, start: at, value: text.slice(quoteAt + 1, closeAt) });
    pos = closeAt + 1;
  }
  return properties;
}

/** "DDD,MM,SSk" or "DDD,MM.mmk" (k one of NSEW) as decimal degrees. */
function xmpDegrees(properties: XmpProperty[], name: string): number | null {
  const property = properties.find((candidate) => candidate.name === name && candidate.value !== null);
  const parsed = property ? xmpCoordinate.exec(property.value ?? "") : null;
  if (!parsed) {
    return null;
  }
  const value = finite(Number(parsed[1]) + Number(parsed[2]) / 60 + Number(parsed[3] ?? "0") / 3600);
  return value === null ? null : signed(value, parsed[4] === "S" || parsed[4] === "W");
}

function xmpLocation(packet: Buffer): PhotoLocation | null {
  const properties = xmpGpsProperties(packet.toString("latin1"));
  const latitude = xmpDegrees(properties, "GPSLatitude");
  const longitude = xmpDegrees(properties, "GPSLongitude");
  return validLocation(latitude, longitude)
    ? { altitude: null, latitude: latitude as number, longitude: longitude as number }
    : null;
}

/** The packet with its GPS properties blanked (same length), or null when it has none. */
export function blankXmpGps(packet: Buffer): Buffer | null {
  const properties = xmpGpsProperties(packet.toString("latin1"));
  if (properties.length === 0) {
    return null;
  }
  const blanked = Buffer.from(packet);
  for (const property of properties) {
    blanked.fill(0x20, property.start, property.end);
  }
  return blanked;
}

// ---------------------------------------------------------------------------
// Location removal: the GPS IFD cut out of IFD0

/**
 * The EXIF block with every GPS pointer cut out of IFD0 (later entries and
 * the next-IFD offset move up, the freed bytes are zero) and each GPS IFD,
 * with the values its entries point to, zeroed. Same length; null when
 * IFD0 points to no GPS IFD.
 */
export function cutExifGps(bytes: Buffer): Buffer | null {
  const tiff = Tiff.open(bytes);
  if (!tiff) {
    return null;
  }
  const ifd0 = tiff.u32(4);
  if (ifd0 === 0 || ifd0 + 2 > tiff.length) {
    return null;
  }
  const count = tiff.u16(ifd0);
  const ifdEnd = ifd0 + 2 + count * 12 + 4;
  if (ifdEnd > tiff.length) {
    return null;
  }
  const entries = Array.from({ length: count }, (_, index) => ifd0 + 2 + index * 12);
  const gpsEntries = entries.filter((at) => tiff.u16(at) === 0x8825);
  if (gpsEntries.length === 0) {
    return null;
  }
  const out = Buffer.from(bytes);
  // The GPS IFDs and their values first, read from the original. Only a
  // real pointer (a LONG or IFD, count 1) is followed.
  for (const at of gpsEntries) {
    const type = tiff.u16(at + 2);
    const gps = (type === 4 || type === 13) && tiff.u32(at + 4) === 1 ? tiff.u32(at + 8) : 0;
    if (gps === 0 || gps + 2 > tiff.length) {
      continue;
    }
    const gpsCount = tiff.u16(gps);
    for (let index = 0; index < gpsCount; index += 1) {
      const entryAt = gps + 2 + index * 12;
      if (entryAt + 12 > tiff.length) {
        break;
      }
      const size = (typeSizes[tiff.u16(entryAt + 2)] ?? 0) * tiff.u32(entryAt + 4);
      if (size > 4) {
        const offset = tiff.u32(entryAt + 8);
        if (offset + size <= tiff.length) {
          out.fill(0, offset, offset + size);
        }
      }
    }
    out.fill(0, gps, Math.min(tiff.length, gps + 2 + gpsCount * 12 + 4));
  }
  // Then IFD0 without them, from the original's bytes.
  const kept = entries.filter((at) => tiff.u16(at) !== 0x8825);
  if (tiff.little) {
    out.writeUInt16LE(kept.length, ifd0);
  } else {
    out.writeUInt16BE(kept.length, ifd0);
  }
  let write = ifd0 + 2;
  for (const at of kept) {
    bytes.copy(out, write, at, at + 12);
    write += 12;
  }
  bytes.copy(out, write, ifdEnd - 4, ifdEnd);
  out.fill(0, write + 4, ifdEnd);
  return out;
}

// ---------------------------------------------------------------------------
// Reading and rewriting

async function readMetadata(source: Source, survey: Survey): Promise<PhotoMetadata> {
  const fields: PhotoMetadataField[] = [];
  let location: PhotoLocation | null = null;
  const blocks = new Set(survey.blocks);
  if (survey.exif) {
    const exif = readExif(await source.read(survey.exif.start, Math.min(survey.exif.length, maxBlockBytes)));
    fields.push(...exif.fields);
    location = exif.location;
    // An EXIF block that only turns the photo is what "remove all" keeps.
    if (exif.orientationOnly && survey.exifBlocks === 1) {
      blocks.delete("exif");
    }
  }
  for (const text of survey.texts) {
    if (fields.length >= maxFields) {
      break;
    }
    const data = await source.read(text.data.start, Math.min(text.data.length, maxTextBytes));
    const keywordEnd = data.indexOf(0);
    const name = capped(data.toString("latin1", 0, keywordEnd < 0 ? data.length : keywordEnd));
    let value = "";
    if (text.type === "zTXt") {
      value = "(compressed)";
    } else if (keywordEnd >= 0 && text.type === "tEXt") {
      value = asciiString(data.subarray(keywordEnd + 1), "latin1");
    } else if (keywordEnd >= 0 && data[keywordEnd + 1] === 1) {
      value = "(compressed)";
    } else if (keywordEnd >= 0) {
      const textAt = itxtTextOffset(data, keywordEnd);
      value = textAt === undefined ? "" : asciiString(data.subarray(textAt));
    }
    fields.push({ group: "Text", name, value });
  }
  if (!location) {
    for (const packet of survey.xmp) {
      location = xmpLocation(await source.read(packet.start, Math.min(packet.length, maxBlockBytes)));
      if (location) {
        break;
      }
    }
  }
  return { blocks: blockOrder.filter((block) => blocks.has(block)), fields, location };
}

/** "remove location": the patched blocks (PNG chunks with their new CRC) as pieces. */
async function locationPieces(source: Source, survey: Survey): Promise<Piece[] | null> {
  const patches: { bytes: Buffer; start: number }[] = [];
  const patch = async (block: Block, edited: Buffer | null) => {
    if (!edited) {
      return;
    }
    if (!block.chunk) {
      patches.push({ bytes: edited, start: block.start });
      return;
    }
    // The whole chunk data, edited, and its CRC over the type and data.
    const { chunk } = block;
    const data = Buffer.from(await source.read(chunk.start, chunk.length));
    edited.copy(data, block.start - chunk.start);
    const type = await source.read(chunk.start - 4, 4);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
    patches.push({ bytes: Buffer.concat([data, crc]), start: chunk.start });
  };
  const fits = (block: Block) => block.length <= maxBlockBytes && (!block.chunk || block.chunk.length <= maxBlockBytes);
  if (survey.exif && fits(survey.exif)) {
    await patch(survey.exif, cutExifGps(await source.read(survey.exif.start, survey.exif.length)));
  }
  for (const packet of survey.xmp) {
    if (fits(packet)) {
      await patch(packet, blankXmpGps(await source.read(packet.start, packet.length)));
    }
  }
  if (patches.length === 0) {
    return null;
  }
  patches.sort((a, b) => a.start - b.start);
  const pieces = new Pieces();
  let at = 0;
  for (const { bytes, start } of patches) {
    pieces.keep(at, start);
    pieces.add(bytes);
    at = start + bytes.length;
  }
  pieces.keep(at, source.size);
  return pieces.list;
}

function bufferReader(bytes: Buffer): Reader {
  return {
    read: async (offset, length) => bytes.subarray(offset, offset + length),
    size: bytes.length,
  };
}

async function withFile<T>(file: PhotoFile, work: (reader: Reader) => Promise<T>): Promise<T> {
  const input = await open(file.path, "r");
  try {
    return await work({
      read: async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await input.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
      },
      size: file.size,
    });
  } finally {
    await input.close();
  }
}

/** What a photo in memory carries. */
export async function readPhotoMetadataBytes(bytes: Buffer): Promise<PhotoMetadata> {
  const source = new Source(bufferReader(bytes));
  return readMetadata(source, await surveyPhoto(source));
}

/** What a photo on disk carries, read at offsets. */
export function readPhotoMetadataFile(file: PhotoFile): Promise<PhotoMetadata> {
  return withFile(file, async (reader) => {
    const source = new Source(reader);
    return readMetadata(source, await surveyPhoto(source));
  });
}

/**
 * Whether the pieces write the input back byte for byte: "remove all" on a
 * photo it already cleaned drops the minimal EXIF block and puts the same
 * one back.
 */
async function writesInput(source: Source, pieces: Piece[]): Promise<boolean> {
  let at = 0;
  for (const piece of pieces) {
    if (Buffer.isBuffer(piece)) {
      if (!piece.equals(await source.read(at, piece.length))) {
        return false;
      }
      at += piece.length;
    } else {
      if (piece.start !== at) {
        return false;
      }
      at = piece.end;
    }
  }
  return at === source.size;
}

async function plan(source: Source, removal: PhotoMetadataRemoval) {
  const survey = await surveyPhoto(source);
  let pieces = removal === "all" ? survey.all : await locationPieces(source, survey);
  if (pieces && (await writesInput(source, pieces))) {
    pieces = null;
  }
  return { format: survey.format, pieces, problem: survey.problem };
}

/** The photo in memory without its location, or without all its metadata. */
export async function removePhotoMetadataBytes(bytes: Buffer, removal: PhotoMetadataRemoval): Promise<RewrittenPhoto> {
  const planned = await plan(new Source(bufferReader(bytes)), removal);
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
    problem: planned.problem,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: body.length,
  };
}

/**
 * The photo on disk without its location, or without all its metadata. A
 * changed photo is written to `outputPath` (the caller removes it); an
 * unchanged one is the input file itself.
 */
export function removePhotoMetadataFile(
  file: PhotoFile,
  removal: PhotoMetadataRemoval,
  outputPath: string,
): Promise<RewrittenPhoto> {
  return withFile(file, async (reader) => {
    const planned = await plan(new Source(reader), removal);
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
      problem: planned.problem,
      sha256: hash.digest("hex"),
      size,
    };
  });
}
