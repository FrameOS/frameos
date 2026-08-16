/* global Buffer, console */
// Walk every row that still keeps its bytes in Postgres and move them into
// object storage (migration 0032). Rows written since that migration already
// carry an `object_key` and are skipped.
//
// Safe to run against a live deployment, and safe to interrupt: each row is
// its own transaction, the object is written BEFORE the row is updated, and
// the key is the content digest — so a re-run after a crash re-uploads
// identical bytes to the same key and costs nothing. Reads keep working
// throughout, because readBlob() serves `content` while it is there and the
// object afterwards.
//
// DRY RUN BY DEFAULT — pass --apply to write.
//
//   DATABASE_URL=... R2_CLOUD_ENDPOINT=... R2_CLOUD_ACCESS_KEY_ID=... \
//   R2_CLOUD_SECRET_ACCESS_KEY=... node scripts/backfill-object-store.mjs [--apply]
//
// Without R2_CLOUD_* credentials it writes to the filesystem driver
// (db/object-storage), which is what a developer wants and NOT what
// production wants — the summary prints which driver it used, check it.
import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { AwsClient } from "aws4fetch";
import postgres from "postgres";

// The two store verbs this script needs (head + put), inlined rather than
// imported from src/lib/object-store.ts. That file is TypeScript inside the
// Next app; this is a plain .mjs chore that has to run on a production host
// against a standalone bundle with no build step (see cloud/docs). Keep the
// key layout and the region="auto" in sync with it — a drift here writes
// objects the app cannot find, which is why the summary prints the driver and
// a sample key.
function createStore() {
  const endpoint = process.env.R2_CLOUD_ENDPOINT?.trim();
  const accessKeyId = process.env.R2_CLOUD_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_CLOUD_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    const root = resolve(
      process.env.FRAMEOS_OBJECT_STORE_DIR?.trim() || "db/object-storage",
    );
    return {
      driver: "fs",
      root,
      async head(key) {
        try {
          return (await stat(join(root, key))).size;
        } catch {
          return undefined;
        }
      },
      async put(key, body) {
        const path = join(root, key);
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, body);
        await rename(temporary, path);
      },
    };
  }
  const client = new AwsClient({
    accessKeyId,
    region: "auto",
    retries: 2,
    secretAccessKey,
    service: "s3",
  });
  const bucket = process.env.R2_CLOUD_BUCKET?.trim() || "frameos-cloud";
  const base = `${endpoint.replace(/\/+$/, "")}/${bucket}`;
  const urlFor = (key) =>
    `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return {
    driver: "s3",
    root: base,
    async head(key) {
      const response = await client.fetch(urlFor(key), { method: "HEAD" });
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`HEAD ${key} failed: ${response.status}`);
      }
      const length = Number(response.headers.get("content-length"));
      return Number.isFinite(length) ? length : 0;
    },
    async put(key, body, contentType) {
      const response = await client.fetch(urlFor(key), {
        body: new Uint8Array(body),
        headers: {
          "content-length": String(body.length),
          "content-type": contentType || "application/octet-stream",
        },
        method: "PUT",
      });
      if (!response.ok) {
        throw new Error(`PUT ${key} failed: ${response.status}`);
      }
    },
  };
}

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

const store = createStore();

// How many rows to hold in memory at once. These are blobs (up to 8 MB
// apiece), and the whole point of the exercise is that they no longer have to
// fit anywhere all at once.
const PAGE_SIZE = 5;

// (namespace, extension) mirror blobNamespaces in src/lib/blobs.ts. Kept as
// literals rather than imported so this script stays runnable against an
// older checkout of the app if a backfill ever has to be replayed.
//
// Each job is three queries rather than one cursor, and that is not a style
// choice: postgres.js runs this with a single connection, a `.cursor()` holds
// that connection for the whole iteration, and the UPDATE issued inside the
// loop then queues behind a cursor that cannot advance until the update runs.
// The result is a process that hangs with Postgres reporting `ClientRead` and
// nothing moved. Paging instead also keeps the transaction short, which
// matters when each step waits on an upload to another continent.
const jobs = [
  {
    contentType: () => "application/zip",
    extension: "zip",
    label: "store_scene_versions",
    namespace: "store/scene-versions",
    count: () =>
      sql`select count(*)::int as rows, coalesce(sum(octet_length(content)), 0)::bigint as bytes
            from store_scene_versions
           where content is not null and object_key is null`,
    page: () =>
      sql`select id, content from store_scene_versions
           where content is not null and object_key is null
           order by created_at asc
           limit ${PAGE_SIZE}`,
    update: (row, key) =>
      sql`update store_scene_versions
             set object_key = ${key}, content = null
           where id = ${row.id} and object_key is null`,
  },
  {
    contentType: (row) => row.preview_image_type ?? "image/jpeg",
    label: "store_scenes.preview_image",
    namespace: "store/scene-previews",
    count: () =>
      sql`select count(*)::int as rows, coalesce(sum(octet_length(preview_image)), 0)::bigint as bytes
            from store_scenes
           where preview_image is not null and preview_object_key is null`,
    page: () =>
      sql`select id, preview_image as content, preview_image_type
            from store_scenes
           where preview_image is not null and preview_object_key is null
           order by created_at asc
           limit ${PAGE_SIZE}`,
    update: (row, key, size) =>
      sql`update store_scenes
             set preview_object_key = ${key},
                 preview_image_size_bytes = ${size},
                 preview_image = null
           where id = ${row.id} and preview_object_key is null`,
  },
  {
    contentType: (row) => row.content_type ?? "image/jpeg",
    label: "store_scene_images",
    namespace: "store/scene-images",
    count: () =>
      sql`select count(*)::int as rows, coalesce(sum(octet_length(content)), 0)::bigint as bytes
            from store_scene_images
           where content is not null and object_key is null`,
    page: () =>
      sql`select id, content, content_type from store_scene_images
           where content is not null and object_key is null
           order by created_at asc
           limit ${PAGE_SIZE}`,
    update: (row, key, size) =>
      sql`update store_scene_images
             set object_key = ${key}, size_bytes = ${size}, content = null
           where id = ${row.id} and object_key is null`,
  },
  {
    contentType: (row) => row.content_type ?? "application/octet-stream",
    label: "frame_asset_files",
    // Per-frame namespace, so the key depends on the row.
    namespace: (row) => `frames/${row.frame_id}/cache`,
    count: () =>
      sql`select count(*)::int as rows, coalesce(sum(octet_length(content)), 0)::bigint as bytes
            from frame_asset_files
           where content is not null and object_key is null`,
    page: () =>
      sql`select id, frame_id, content, content_type from frame_asset_files
           where content is not null and object_key is null
           order by updated_at asc
           limit ${PAGE_SIZE}`,
    update: (row, key, size) =>
      sql`update frame_asset_files
             set object_key = ${key}, size_bytes = ${size}, content = null
           where id = ${row.id} and object_key is null`,
  },
];

const summary = {
  bytes: {},
  driver: store.driver,
  dryRun: !apply,
  moved: {},
  root: store.root,
  sampleKey: undefined,
};

function objectKeyFor(job, row, content) {
  const namespace =
    typeof job.namespace === "function" ? job.namespace(row) : job.namespace;
  const digest = createHash("sha256").update(content).digest("hex");
  return `${namespace}/${digest}${job.extension ? `.${job.extension}` : ""}`;
}

try {
  for (const job of jobs) {
    // A dry run only has to answer "how much is left", and one aggregate is a
    // far cheaper way to ask than reading every blob out of TOAST storage.
    if (!apply) {
      const [totals] = await job.count();
      summary.moved[job.label] = Number(totals?.rows ?? 0);
      summary.bytes[job.label] = Number(totals?.bytes ?? 0);
      if (summary.sampleKey === undefined && Number(totals?.rows ?? 0) > 0) {
        const [sample] = await job.page();
        if (sample) {
          summary.sampleKey = objectKeyFor(job, sample, Buffer.from(sample.content));
        }
      }
      continue;
    }

    let moved = 0;
    let bytes = 0;
    // Page rather than cursor. A moved row stops matching the page's own
    // WHERE (it now has an object_key), so re-running the same query walks
    // forward without an offset — and a run interrupted half way resumes
    // exactly where it stopped.
    for (;;) {
      const rows = await job.page();
      if (rows.length === 0) {
        break;
      }
      let updated = 0;
      for (const row of rows) {
        const content = Buffer.from(row.content);
        const key = objectKeyFor(job, row, content);
        summary.sampleKey ??= key;
        const existing = await store.head(key);
        if (existing !== content.length) {
          await store.put(key, content, job.contentType(row));
        }
        // `and object_key is null` in every update: if a concurrent write
        // already moved this row, leave its key alone.
        const result = await job.update(row, key, content.length);
        updated += result.count ?? 0;
        moved += 1;
        bytes += content.length;
      }
      if (updated === 0) {
        // Nothing in that page could be claimed — another writer owns them.
        // Stop rather than fetch the same page forever.
        break;
      }
    }
    summary.moved[job.label] = moved;
    summary.bytes[job.label] = bytes;
  }
} finally {
  await sql.end();
}

console.log(JSON.stringify(summary, null, 2));
if (!apply) {
  console.log("\nDry run. Re-run with --apply to move the bytes.");
}
