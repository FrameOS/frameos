import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { detectImageContentType } from "../store";
import { exifOrientation, imageDimensions } from "./image-info";
import { minimalExifTiff, stripPhotoMetadataBytes, stripPhotoMetadataFile } from "./metadata";

// The conformance corpus both planes replay (tools/generate_photo_metadata_fixtures.py);
// the backend's runner is app/utils/tests/test_photo_metadata.py.
const repoRoot = join(__dirname, "..", "..", "..", "..", "..", "..");
const fixturesDir = join(repoRoot, "docs", "photo-metadata-fixtures");
const corpus = JSON.parse(readFileSync(join(repoRoot, "docs", "photo-metadata-fixtures.json"), "utf8")) as {
  cases: {
    changed: boolean;
    inputSha256: string;
    malformed: boolean;
    name: string;
    orientation: number | null;
    outputSha256: string;
    secrets: string[];
    truncated: boolean;
  }[];
};

const scratch = mkdtempSync(join(tmpdir(), "photo-metadata-"));
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function input(name: string) {
  return readFileSync(join(fixturesDir, name));
}

async function stripped(name: string) {
  const result = await stripPhotoMetadataBytes(input(name));
  return result.body as Buffer;
}

describe("stripPhotoMetadata: the corpus", () => {
  it.each(corpus.cases)("$name: the bytes the backend writes", async (fixture) => {
    const bytes = input(fixture.name);
    expect(sha256(bytes)).toBe(fixture.inputSha256);
    const result = await stripPhotoMetadataBytes(bytes);
    const body = result.body as Buffer;
    expect(sha256(body)).toBe(fixture.outputSha256);
    expect(result.changed).toBe(fixture.changed);
    expect(result.problem !== null).toBe(fixture.malformed);
    expect(result.size).toBe(body.length);
    expect(result.sha256).toBe(fixture.changed ? fixture.outputSha256 : null);
    if (!fixture.changed) {
      expect(result.body).toBe(bytes);
    }
  });

  it.each(corpus.cases)("$name: the same bytes from a file on disk", async (fixture) => {
    const path = join(fixturesDir, fixture.name);
    const output = join(scratch, `${fixture.name}.clean`);
    const result = await stripPhotoMetadataFile({ path, size: input(fixture.name).length }, output);
    expect(result.changed).toBe(fixture.changed);
    if (fixture.changed) {
      expect(result.body).toEqual({ path: output, size: result.size });
      expect(sha256(readFileSync(output))).toBe(fixture.outputSha256);
      expect(result.sha256).toBe(fixture.outputSha256);
    } else {
      expect(result.body).toEqual({ path, size: input(fixture.name).length });
    }
  });

  it.each(corpus.cases.filter((fixture) => fixture.changed))(
    "$name: the same pixels, the same way up, nothing planted left",
    async (fixture) => {
      const before = input(fixture.name);
      const after = await stripped(fixture.name);
      const open = (bytes: Buffer) => sharp(bytes, { failOn: "none" });
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
    },
  );
});

describe("stripPhotoMetadata", () => {
  it("writes the minimal EXIF every reader takes", () => {
    expect(minimalExifTiff(6).toString("hex")).toBe("4d4d002a00000008000101120003000000010006000000000000");
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      const segment = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), minimalExifTiff(orientation)]);
      expect(exifOrientation(segment)).toBe(orientation);
    }
  });

  it("follows entropy data across reads, stuffed bytes, restarts and fill bytes", async () => {
    // A 0xff as the last byte of the first 1 MiB read, its 0x00 in the next.
    const { bytes, expected } = bigJpeg();
    const result = await stripPhotoMetadataBytes(bytes);
    expect((result.body as Buffer).equals(expected)).toBe(true);
    const path = join(scratch, "big.jpg");
    writeFileSync(path, bytes);
    const fromDisk = await stripPhotoMetadataFile({ path, size: bytes.length }, `${path}.clean`);
    expect(readFileSync(`${path}.clean`).equals(expected)).toBe(true);
    expect(fromDisk.sha256).toBe(sha256(expected));
  });

  it("leaves what it does not know alone", async () => {
    for (const bytes of [Buffer.from("not a photo at all"), Buffer.from([0xff, 0xd8, 0xff])]) {
      const result = await stripPhotoMetadataBytes(bytes);
      expect(result).toMatchObject({ changed: false, format: null, problem: null });
      expect(result.body).toBe(bytes);
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
