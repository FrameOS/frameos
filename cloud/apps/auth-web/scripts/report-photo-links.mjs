/* global console, URL */
// Read-only report: store scene versions that hold a Photos share link and
// that someone other than the owner can read (docs/photos.md "Share links",
// src/lib/store-photo-links.ts). A share link is a credential for a whole
// album, and album scenes carry one; the store now refuses to make such a
// scene public or give it a sharing link, but versions published before
// that may still be out there:
//
//   - every version of a public scene (each stays downloadable by number),
//   - every version of a private scene whose sharing link is on
//     (share_token set). The share-token door no longer serves these, but
//     the link was readable until it shipped.
//
// It writes nothing. What to do about a hit is the operator's call: tell
// the owner, rotate the album's share link (Photos → the album → links),
// make the scene private or turn its sharing link off.
//
//   DATABASE_URL=... node scripts/report-photo-links.mjs
//
// Objects are read from R2 when R2_CLOUD_ENDPOINT and the R2_CLOUD_*
// credentials are set (production), else from FRAMEOS_OBJECT_STORE_DIR or
// the repo's db/object-storage (local). In production, run it from a
// directory with `postgres` and `aws4fetch` installed (cloud/docs/
// deployment.md, "Running a one-off script against production").
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import postgres from "postgres";

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

const pageSize = 50;
const readObject = await objectReader();

const summary = {
  missingObjects: 0,
  publicScenes: new Set(),
  sharedScenes: new Set(),
  unreadableZips: 0,
  versionsScanned: 0,
  versionsWithLinks: [],
};

try {
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = await sql`
      select v.id, v.version, v.object_key, v.content, v.yanked_at,
             s.id as scene_id, s.slug, s.name, s.visibility, s.status,
             s.share_token is not null as shared, s.account_id
      from store_scene_versions v
      join store_scenes s on s.id = v.scene_id
      where (s.visibility = 'public' or s.share_token is not null)
        and v.id > ${after}::uuid
      order by v.id asc
      limit ${pageSize}
    `;
    if (rows.length === 0) {
      break;
    }
    after = rows[rows.length - 1].id;
    for (const row of rows) {
      summary.versionsScanned += 1;
      const zip =
        row.content && row.content.length > 0
          ? Buffer.from(row.content)
          : row.object_key
            ? await readObject(row.object_key)
            : undefined;
      if (!zip) {
        summary.missingObjects += 1;
        continue;
      }
      const scenesJson = shallowestScenesJson(zip);
      if (scenesJson === undefined) {
        summary.unreadableZips += 1;
        continue;
      }
      const links = countShareLinks(scenesJson);
      if (links === 0) {
        continue;
      }
      (row.visibility === "public" ? summary.publicScenes : summary.sharedScenes).add(row.scene_id);
      summary.versionsWithLinks.push({
        accountId: row.account_id,
        links,
        name: row.name,
        sceneId: row.scene_id,
        shared: row.shared,
        slug: row.slug,
        status: row.status,
        version: row.version,
        visibility: row.visibility,
        yanked: row.yanked_at !== null,
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        ...summary,
        publicScenes: summary.publicScenes.size,
        sharedScenes: summary.sharedScenes.size,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 5 });
}

// Compact copy of the detector in src/lib/photos/share-links-in-scenes.ts
// (scripts are plain ESM and cannot import the TS lib). Keep the two in
// step: the share route's path and a token, any host in front, slashes
// possibly escaped. A bare pk_ is not a link.
function countShareLinks(text) {
  if (!text.includes("pk_")) {
    return 0;
  }
  const slash = String.raw`(?:\\*\/|%2[Ff])`;
  const pattern = new RegExp(
    `${slash}api${slash}photos${slash}shared${slash}(pk_[A-Za-z0-9_-]{32,128})(?![A-Za-z0-9_-])`,
    "g",
  );
  return new Set([...text.matchAll(pattern)].map((match) => match[1])).size;
}

// The shallowest scenes.json of a zip, as text (validateSceneZip's rule), or
// undefined when the zip cannot be read. A small central-directory reader:
// the release's script directory has no fflate.
function shallowestScenesJson(zip) {
  try {
    let end = -1;
    for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65_557); offset -= 1) {
      if (zip.readUInt32LE(offset) === 0x06054b50) {
        end = offset;
        break;
      }
    }
    if (end < 0) {
      return undefined;
    }
    const entries = zip.readUInt16LE(end + 10);
    let offset = zip.readUInt32LE(end + 16);
    let best;
    for (let index = 0; index < entries; index += 1) {
      if (zip.readUInt32LE(offset) !== 0x02014b50) {
        return undefined;
      }
      const method = zip.readUInt16LE(offset + 10);
      const compressedSize = zip.readUInt32LE(offset + 20);
      const nameLength = zip.readUInt16LE(offset + 28);
      const extraLength = zip.readUInt16LE(offset + 30);
      const commentLength = zip.readUInt16LE(offset + 32);
      const localOffset = zip.readUInt32LE(offset + 42);
      const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
      if (/(^|\/)scenes\.json$/.test(name)) {
        const depth = name.split("/").length;
        if (!best || depth < best.depth || (depth === best.depth && name < best.name)) {
          best = { compressedSize, depth, localOffset, method, name };
        }
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }
    if (!best) {
      return undefined;
    }
    const localNameLength = zip.readUInt16LE(best.localOffset + 26);
    const localExtraLength = zip.readUInt16LE(best.localOffset + 28);
    const start = best.localOffset + 30 + localNameLength + localExtraLength;
    const body = zip.subarray(start, start + best.compressedSize);
    if (best.method === 0) {
      return body.toString("utf8");
    }
    if (best.method === 8) {
      return inflateRawSync(body, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8");
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function objectReader() {
  const endpoint = process.env.R2_CLOUD_ENDPOINT?.trim();
  const accessKeyId = process.env.R2_CLOUD_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_CLOUD_SECRET_ACCESS_KEY?.trim();
  if (endpoint && accessKeyId && secretAccessKey) {
    const { AwsClient } = await import("aws4fetch");
    const client = new AwsClient({
      accessKeyId,
      region: "auto",
      retries: 2,
      secretAccessKey,
      service: "s3",
    });
    const base = `${endpoint.replace(/\/+$/, "")}/${process.env.R2_CLOUD_BUCKET?.trim() || "frameos-cloud"}`;
    return async (key) => {
      const response = await client.fetch(
        `${base}/${key.split("/").map(encodeURIComponent).join("/")}`,
        { method: "GET" },
      );
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`GET ${key} failed: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    };
  }
  const root = process.env.FRAMEOS_OBJECT_STORE_DIR?.trim()
    ? resolve(process.env.FRAMEOS_OBJECT_STORE_DIR.trim())
    : fileURLToPath(new URL("../../../../db/object-storage", import.meta.url));
  return async (key) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/.test(key) || key.split("/").includes("..")) {
      return undefined;
    }
    try {
      return await readFile(join(root, key));
    } catch {
      return undefined;
    }
  };
}
