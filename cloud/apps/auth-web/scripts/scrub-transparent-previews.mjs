/* global console */
// Maintenance sweep for the "transparent preview_image" bug: live-preview
// screenshots captured before the wasm runtime painted its first frame were
// fully transparent PNGs, and made blank tiles wherever they were served.
// Upload paths now reject them (preview_image_fully_transparent); this script
// scrubs the rows that got in before the fix:
//   - store_scene_images rows whose bytes are proven fully transparent are
//     deleted,
//   - store_scenes preview_image columns holding proven fully transparent
//     bytes are nulled.
// DRY RUN BY DEFAULT — pass --apply to write. Zips are untouched; run
// `pnpm scene:sync-preview -- <slug>` afterwards for any listed slug whose
// downloadable ZIP should be rebuilt without the scrubbed lead image.
//
//   DATABASE_URL=... node scripts/scrub-transparent-previews.mjs [--apply]
import process from "node:process";
import { unzlibSync } from "fflate";
import postgres from "postgres";

const apply = process.argv.includes("--apply");
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  ...(process.env.DATABASE_SSL === "require" ||
  process.env.DATABASE_SSL === "true"
    ? { ssl: "require" }
    : {}),
});

const summary = {
  dryRun: !apply,
  galleryImagesDeleted: [],
  galleryImagesScanned: 0,
  previewsNulled: [],
  previewsScanned: 0,
};

try {
  // Gallery rows first: cursor through the blobs one at a time.
  for await (const rows of sql`
    select id, scene_id, content
    from store_scene_images
    order by created_at asc
  `.cursor(5)) {
    for (const row of rows) {
      summary.galleryImagesScanned += 1;
      if (!isProvablyFullyTransparentImage(new Uint8Array(row.content))) {
        continue;
      }
      summary.galleryImagesDeleted.push({ id: row.id, sceneId: row.scene_id });
      if (apply) {
        await sql`delete from store_scene_images where id = ${row.id}`;
      }
    }
  }

  // Primary storefront previews extracted at publish time.
  for await (const rows of sql`
    select id, slug, preview_image
    from store_scenes
    where preview_image is not null
    order by created_at asc
  `.cursor(5)) {
    for (const row of rows) {
      summary.previewsScanned += 1;
      if (
        !isProvablyFullyTransparentImage(new Uint8Array(row.preview_image))
      ) {
        continue;
      }
      summary.previewsNulled.push({ id: row.id, slug: row.slug });
      if (apply) {
        await sql`
          update store_scenes
          set preview_image = null,
              preview_image_type = null,
              preview_image_width = null,
              preview_image_height = null,
              updated_at = now()
          where id = ${row.id}
        `;
      }
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!apply) {
    console.log("Dry run — nothing was changed. Re-run with --apply to write.");
  }
} finally {
  await sql.end({ timeout: 5 });
}

// Compact duplicate of isProvablyFullyTransparentImage in src/lib/store.ts
// (scripts are plain ESM and cannot import the TS lib — same hand-rolled
// pattern as set-scene-preview.mjs). Keep the two in sync. Returns true only
// when every alpha byte of an 8-bit non-interlaced grey+alpha/RGBA PNG is
// provably zero; everything else (other formats, palette, 16-bit, Adam7,
// malformed, oversized) is accepted as possibly visible.
function isProvablyFullyTransparentImage(content) {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    content.length < 33 ||
    pngSignature.some((byte, i) => content[i] !== byte)
  ) {
    return false;
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawIhdr = false;
  let sawTrns = false;
  const idatChunks = [];
  let idatBytes = 0;
  let offset = 8;
  while (offset + 8 <= content.length) {
    const length =
      (content[offset] << 24) |
      (content[offset + 1] << 16) |
      (content[offset + 2] << 8) |
      content[offset + 3];
    if (length < 0 || offset + 12 + length > content.length) {
      return false;
    }
    const type = String.fromCharCode(
      content[offset + 4],
      content[offset + 5],
      content[offset + 6],
      content[offset + 7],
    );
    const data = content.subarray(offset + 8, offset + 8 + length);
    if (!sawIhdr) {
      if (type !== "IHDR" || length !== 13) {
        return false;
      }
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      sawIhdr = true;
    } else if (type === "tRNS") {
      sawTrns = true;
    } else if (type === "IDAT") {
      idatChunks.push(data);
      idatBytes += data.length;
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!sawIhdr || idatChunks.length === 0 || width <= 0 || height <= 0) {
    return false;
  }
  if (colorType === 0 || colorType === 2 || colorType === 3) {
    return false;
  }
  if (
    (colorType !== 4 && colorType !== 6) ||
    bitDepth !== 8 ||
    interlace !== 0 ||
    sawTrns
  ) {
    return false;
  }
  const channels = colorType === 4 ? 2 : 4;
  const stride = width * channels;
  const rawSize = height * (1 + stride);
  if (rawSize > 64 * 1024 * 1024) {
    return false;
  }
  let raw;
  try {
    const compressed = new Uint8Array(idatBytes);
    let idatOffset = 0;
    for (const chunk of idatChunks) {
      compressed.set(chunk, idatOffset);
      idatOffset += chunk.length;
    }
    raw = unzlibSync(compressed);
  } catch {
    return false;
  }
  if (raw.length < rawSize) {
    return false;
  }
  const previous = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  let position = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[position];
    position += 1;
    for (let x = 0; x < stride; x++) {
      const value = raw[position + x];
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let reconstructed;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + left;
          break;
        case 2:
          reconstructed = value + up;
          break;
        case 3:
          reconstructed = value + ((left + up) >> 1);
          break;
        case 4:
          reconstructed = value + paethPredictor(left, up, upLeft);
          break;
        default:
          return false;
      }
      line[x] = reconstructed & 0xff;
    }
    position += stride;
    for (let alpha = channels - 1; alpha < stride; alpha += channels) {
      if (line[alpha] !== 0) {
        return false;
      }
    }
    previous.set(line);
  }
  return true;
}

function paethPredictor(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) {
    return left;
  }
  return pb <= pc ? up : upLeft;
}
