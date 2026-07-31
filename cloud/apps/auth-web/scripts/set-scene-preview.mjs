/* global console */
// Maintenance companion to sync-scene-preview.mjs: replace a scene's primary
// storefront image (store_scenes.preview_image) from a JPEG file on disk.
// Run scene:sync-preview afterwards to fold the new image into the scene's
// downloadable ZIP as a new version.
//
//   DATABASE_URL=... node scripts/set-scene-preview.mjs <scene-slug> <image.jpg>
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import process from "node:process";
import postgres from "postgres";

const maxPreviewImageBytes = 4 * 1024 * 1024;

const slug = process.argv[2]?.trim();
const imagePath = process.argv[3]?.trim();
if (!slug || !imagePath) {
  throw new Error(
    "Usage: node scripts/set-scene-preview.mjs <scene-slug> <image.jpg>",
  );
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const content = readFileSync(imagePath);
if (content.length > maxPreviewImageBytes) {
  throw new Error(`Image exceeds ${maxPreviewImageBytes} bytes`);
}
if (!(content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff)) {
  throw new Error("Only JPEG images are supported (store convention)");
}
const dimensions = jpegDimensions(content);
if (!dimensions) {
  throw new Error("Could not read JPEG dimensions");
}

const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  ...(process.env.DATABASE_SSL === "require" ||
  process.env.DATABASE_SSL === "true"
    ? { ssl: "require" }
    : {}),
});

try {
  const [updated] = await sql`
    update store_scenes
    set preview_image = ${content},
        preview_image_type = 'image/jpeg',
        preview_image_width = ${dimensions.width},
        preview_image_height = ${dimensions.height},
        updated_at = now()
    where slug = ${slug}
    returning id
  `;
  if (!updated) {
    throw new Error(`Scene not found: ${slug}`);
  }
  console.log(
    JSON.stringify({
      bytes: content.length,
      sceneId: updated.id,
      slug,
      ...dimensions,
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
}

// Minimal JPEG SOF scan — enough for the images this maintenance script
// handles; anything unparseable is rejected above.
function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // SOF0-SOF15, excluding DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: Buffer.from(bytes).readUInt16BE(offset + 5),
        width: Buffer.from(bytes).readUInt16BE(offset + 7),
      };
    }
    const length = Buffer.from(bytes).readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  return undefined;
}
