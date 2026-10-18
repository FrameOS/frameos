import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { detectImageContentType } from "../store";
import { exifOrientation, imageDimensions } from "./image-info";
import {
  blankXmpGps,
  minimalExifTiff,
  readExif,
  readPhotoMetadataBytes,
  readPhotoMetadataFile,
  removePhotoMetadataBytes,
  removePhotoMetadataFile,
} from "./metadata";

// The conformance corpus both planes replay (tools/generate_photo_metadata_fixtures.py);
// the backend's runner is app/utils/tests/test_photo_metadata.py.
const repoRoot = join(__dirname, "..", "..", "..", "..", "..", "..");
const fixturesDir = join(repoRoot, "docs", "photo-metadata-fixtures");
type Case = {
  inputSha256: string;
  metadata: unknown;
  name: string;
  orientation: number | null;
  removeAll: { changed: boolean; malformed: boolean; sha256: string };
  removeLocation: { changed: boolean; sha256: string };
  secrets: string[];
  truncated: boolean;
};
const corpus = JSON.parse(readFileSync(join(repoRoot, "docs", "photo-metadata-fixtures.json"), "utf8")) as {
  cases: Case[];
};
const images = corpus.cases.filter((fixture) => !fixture.name.endsWith(".gif"));

const scratch = mkdtempSync(join(tmpdir(), "photo-metadata-"));
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function input(name: string) {
  return readFileSync(join(fixturesDir, name));
}

async function rewritten(name: string, removal: "location" | "all") {
  return (await removePhotoMetadataBytes(input(name), removal)).body as Buffer;
}

const open = (bytes: Buffer) => sharp(bytes, { failOn: "none" });

/** Every PNG chunk's CRC, true when all are right. */
function pngCrcsHold(bytes: Buffer) {
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    if (at + 12 + length > bytes.length) {
      return true;
    }
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(at + 8 + length)) {
      return false;
    }
    if (bytes.toString("latin1", at + 4, at + 8) === "IEND") {
      return true;
    }
    at += 12 + length;
  }
  return true;
}

describe("photo metadata: the corpus", () => {
  it.each(corpus.cases)("$name: the metadata the backend reads", async (fixture) => {
    const bytes = input(fixture.name);
    expect(sha256(bytes)).toBe(fixture.inputSha256);
    expect(await readPhotoMetadataBytes(bytes)).toEqual(fixture.metadata);
    const path = join(fixturesDir, fixture.name);
    expect(await readPhotoMetadataFile({ path, size: bytes.length })).toEqual(fixture.metadata);
  });

  it.each(corpus.cases)("$name: the bytes the backend writes", async (fixture) => {
    const bytes = input(fixture.name);
    for (const [removal, expected] of [
      ["location", fixture.removeLocation],
      ["all", fixture.removeAll],
    ] as const) {
      const result = await removePhotoMetadataBytes(bytes, removal);
      const body = result.body as Buffer;
      expect(sha256(body), removal).toBe(expected.sha256);
      expect(result.changed, removal).toBe(expected.changed);
      expect(result.size).toBe(body.length);
      expect(result.sha256).toBe(expected.changed ? expected.sha256 : null);
      if (!expected.changed) {
        expect(result.body).toBe(bytes);
      }
      // From a file on disk, range by range: the same bytes.
      const output = join(scratch, `${fixture.name}.${removal}`);
      const path = join(fixturesDir, fixture.name);
      const fromDisk = await removePhotoMetadataFile({ path, size: bytes.length }, removal, output);
      expect(fromDisk.changed).toBe(expected.changed);
      expect(fromDisk.sha256).toBe(expected.changed ? expected.sha256 : null);
      if (expected.changed) {
        expect(sha256(readFileSync(output))).toBe(expected.sha256);
      }
    }
    expect((await removePhotoMetadataBytes(bytes, "all")).problem !== null).toBe(fixture.removeAll.malformed);
  });

  it.each(images.filter((fixture) => fixture.removeLocation.changed))(
    "$name: without its location, the same pixels, length and everything else",
    async (fixture) => {
      const before = input(fixture.name);
      const after = await rewritten(fixture.name, "location");
      expect(after.length).toBe(before.length);
      expect((await readPhotoMetadataBytes(after)).location).toBeNull();
      expect(after.includes("exif:GPS")).toBe(false);
      const [was, is] = [await open(before).metadata(), await open(after).metadata()];
      expect([is.width, is.height, is.orientation]).toEqual([was.width, was.height, was.orientation]);
      expect((await open(after).raw().toBuffer()).equals(await open(before).raw().toBuffer())).toBe(true);
      if (fixture.name.endsWith(".png")) {
        expect(pngCrcsHold(after)).toBe(true);
      }
      // Every other field is still there; the Location group is gone.
      const fields = (await readPhotoMetadataBytes(after)).fields;
      const expected = (fixture.metadata as { fields: { group: string }[] }).fields.filter(
        (field) => field.group !== "Location",
      );
      expect(fields).toEqual(expected);
      // Twice is once.
      expect((await removePhotoMetadataBytes(after, "location")).changed).toBe(false);
    },
  );

  it.each(images.filter((fixture) => fixture.removeAll.changed))(
    "$name: without all metadata, the same pixels, the same way up, nothing planted left",
    async (fixture) => {
      const before = input(fixture.name);
      const after = await rewritten(fixture.name, "all");
      const [was, is] = [await open(before).metadata(), await open(after).metadata()];
      expect([is.width, is.height]).toEqual([was.width, was.height]);
      expect(is.orientation ?? 1).toBe(fixture.orientation ?? 1);
      // Lossless: the decoded pixels are the original's.
      expect((await open(after).raw().toBuffer()).equals(await open(before).raw().toBuffer())).toBe(true);
      // Only the orientation is left of the EXIF; no XMP, no text.
      const minimal = minimalExifTiff(fixture.orientation ?? 1);
      expect(is.exif === undefined || is.exif.subarray(-minimal.length).equals(minimal)).toBe(true);
      expect(is.exif === undefined).toBe(fixture.orientation === null);
      expect(is.xmp).toBeUndefined();
      expect(is.comments ?? []).toEqual([]);
      expect(is.icc?.length).toBe(was.icc?.length);
      const type = detectImageContentType(after) ?? "";
      expect(imageDimensions(after, type)).toEqual(imageDimensions(before, type));
      for (const secret of fixture.secrets) {
        expect(before.includes(secret)).toBe(true);
        expect(after.includes(secret), secret).toBe(false);
      }
      if (type === "image/jpeg" && !fixture.truncated) {
        // Ends at the primary image's EOI: no second image, no video.
        expect(after.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
      }
      // What is left reads as nothing to remove.
      expect((await readPhotoMetadataBytes(after)).blocks).toEqual([]);
      expect((await removePhotoMetadataBytes(after, "all")).changed).toBe(false);
    },
  );
});

describe("photo metadata", () => {
  it("writes the minimal EXIF every reader takes", () => {
    expect(minimalExifTiff(6).toString("hex")).toBe("4d4d002a00000008000101120003000000010006000000000000");
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      const segment = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), minimalExifTiff(orientation)]);
      expect(exifOrientation(segment)).toBe(orientation);
      expect(readExif(minimalExifTiff(orientation))).toEqual({
        fields: [{ group: "Image", name: "Orientation", value: orientation }],
        location: null,
        orientationOnly: true,
      });
    }
  });

  it("follows entropy data across reads, stuffed bytes, restarts and fill bytes", async () => {
    // A 0xff as the last byte of the first 1 MiB read, its 0x00 in the next.
    const { bytes, expected } = bigJpeg();
    const result = await removePhotoMetadataBytes(bytes, "all");
    expect((result.body as Buffer).equals(expected)).toBe(true);
    const path = join(scratch, "big.jpg");
    writeFileSync(path, bytes);
    const fromDisk = await removePhotoMetadataFile({ path, size: bytes.length }, "all", `${path}.clean`);
    expect(readFileSync(`${path}.clean`).equals(expected)).toBe(true);
    expect(fromDisk.sha256).toBe(sha256(expected));
    expect((await readPhotoMetadataFile({ path, size: bytes.length })).blocks).toEqual(["trailer"]);
  });

  it("blanks XMP GPS properties in place, and stops on hostile packets", () => {
    const packet = Buffer.from('<d exif:GPSLatitude="1,2N" a="b"><exif:GPSSpeed>3</exif:GPSSpeed ></d>', "latin1");
    expect(blankXmpGps(packet)?.toString("latin1")).toBe(`<d ${" ".repeat(23)} a="b">${" ".repeat(33)}</d>`);
    // An unclosed element or quote is left alone, and many of them are cheap.
    const hostile = Buffer.from(`${"<exif:GPSa>".repeat(200_000)}exif:GPSb="`, "latin1");
    const started = Date.now();
    expect(blankXmpGps(hostile)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("leaves what it does not know alone", async () => {
    for (const bytes of [Buffer.from("not a photo at all"), Buffer.from([0xff, 0xd8, 0xff])]) {
      expect(await readPhotoMetadataBytes(bytes)).toEqual({ blocks: [], fields: [], location: null });
      for (const removal of ["location", "all"] as const) {
        const result = await removePhotoMetadataBytes(bytes, removal);
        expect(result).toMatchObject({ changed: false, format: null, problem: null });
        expect(result.body).toBe(bytes);
      }
    }
  });
});

/** The backend's test builds the same file (test_photo_metadata.py big_jpeg). */
function bigJpeg() {
  const soi = Buffer.from([0xff, 0xd8]);
  // Little-endian EXIF, turned 6: replaced by the big-endian minimal block.
  const tiff = Buffer.from("49492a0008000000010012010300010000000600000000000000", "hex");
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, tiff.length + 8]), Buffer.from("Exif\0\0", "latin1"), tiff]);
  const minimal = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 34]), Buffer.from("Exif\0\0", "latin1"), minimalExifTiff(6)]);
  const sof = Buffer.from("ffc00011080010001003012200021101031101", "hex");
  const sos = Buffer.from("ffda000c03010002110311003f00", "hex");
  const data = Buffer.concat([
    Buffer.alloc(1024 * 1024 - 1, 0x11),
    Buffer.from([0xff, 0x00]),
    Buffer.alloc(1000, 0x22),
    Buffer.from([0xff, 0xd3]),
    Buffer.alloc(10, 0x33),
    Buffer.from([0xff, 0xff, 0xd9]),
  ]);
  const trailer = Buffer.from("secret trailer", "latin1");
  return {
    bytes: Buffer.concat([soi, app1, sof, sos, data, trailer]),
    expected: Buffer.concat([soi, minimal, sof, sos, data]),
  };
}
