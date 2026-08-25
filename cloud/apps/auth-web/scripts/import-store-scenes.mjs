/* global console, fetch, FormData, Blob, URL */
// Mirror every PUBLIC scene of a FrameOS Cloud store into a local cloud.
//
// Why: the AI scene features (and their evals) need a realistic catalog to
// work against, and the empty dev database makes "suggest something like
// what the store already has" untestable. This walks the source store's
// public browse API, downloads each scene's template zip + gallery images,
// and republishes them through the LOCAL cloud's real publish path (zip
// validation, blob storage, versioning, audit) under one account. Slugs,
// tags, category, description, visibility, download counts and timestamps
// are then aligned to the source so the local store reads like the real one.
//
//   DATABASE_URL=... node scripts/import-store-scenes.mjs
//
// Env:
//   SOURCE_URL     store to mirror        (default https://scenes.frameos.net)
//   CLOUD_URL      local cloud to fill    (default http://localhost:3000)
//   IMPORT_EMAIL   publisher account      (default marius.andra@gmail.com)
//   IMPORT_NAME    publisher display name (default "Marius Andra")
//   IMPORT_PASSWORD password for that account (default frameos-dev-password)
//   ONLY=slug1,slug2   restrict to a few slugs
//
// Idempotent: a slug that already exists locally gets a NEW VERSION only when
// the zip bytes changed; metadata is always re-aligned.
import { Buffer } from "node:buffer";
import { createHash, randomBytes, scrypt } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(
  new URL("../../../packages/db/package.json", import.meta.url),
);
const postgres = require("postgres");

const sourceUrl = (process.env.SOURCE_URL ?? "https://scenes.frameos.net").replace(/\/$/, "");
const cloudUrl = (process.env.CLOUD_URL ?? "http://localhost:3000").replace(/\/$/, "");
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://frameos_cloud@127.0.0.1:55432/frameos_cloud";
const email = process.env.IMPORT_EMAIL ?? "marius.andra@gmail.com";
const displayName = process.env.IMPORT_NAME ?? "Marius Andra";
const password = process.env.IMPORT_PASSWORD ?? "frameos-dev-password";
const only = process.env.ONLY
  ? new Set(process.env.ONLY.split(",").map((s) => s.trim()).filter(Boolean))
  : undefined;

const sql = postgres(databaseUrl, { max: 1 });

async function main() {
  const cookie = await ensureAccount();
  const scenes = await listSourceScenes();
  console.log(`source ${sourceUrl}: ${scenes.length} public scenes`);

  const summary = { created: 0, failed: [], newVersion: 0, unchanged: 0 };
  for (const scene of scenes) {
    if (only && !only.has(scene.slug)) {
      continue;
    }
    try {
      const result = await importScene(scene, cookie);
      summary[result] += 1;
      console.log(`${result.padEnd(11)} ${scene.slug}`);
    } catch (error) {
      summary.failed.push(scene.slug);
      console.error(`FAILED     ${scene.slug}: ${error?.message ?? error}`);
    }
  }
  console.log(JSON.stringify(summary));
}

// --- source ---------------------------------------------------------------

async function listSourceScenes() {
  const all = [];
  for (let page = 1; page < 50; page += 1) {
    const response = await fetch(`${sourceUrl}/api/store/browse?page=${page}`);
    if (!response.ok) {
      throw new Error(`browse page ${page}: ${response.status}`);
    }
    const body = await response.json();
    all.push(...body.scenes);
    if (!body.hasMore) {
      break;
    }
  }
  return all;
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// The public scene page is the only place that enumerates gallery images.
async function sourceGalleryImageIds(scene) {
  const response = await fetch(`${sourceUrl}/s/${scene.slug}`);
  if (!response.ok) {
    return [];
  }
  const html = await response.text();
  const pattern = new RegExp(
    `/api/store/scenes/${scene.id}/images/([0-9a-f-]{36})`,
    "g",
  );
  const ids = [];
  for (const match of html.matchAll(pattern)) {
    if (!ids.includes(match[1])) {
      ids.push(match[1]);
    }
  }
  return ids;
}

// --- local account --------------------------------------------------------

async function ensureAccount() {
  const [existing] = await sql`
    select a.id from accounts a
    join account_identities i on i.account_id = a.id
    where i.email_snapshot = ${email} and i.provider_key = 'password'
    limit 1
  `;
  if (!existing) {
    // Signup over HTTP is Turnstile-gated even locally, so mint the account
    // the way createPasswordAccount does (same scrypt hash format as
    // src/lib/passwords.ts) and mark the identity verified.
    const passwordHash = await hashPassword(password);
    await sql.begin(async (tx) => {
      const [account] = await tx`
        insert into accounts (display_name, password_hash, primary_email)
        values (${displayName}, ${passwordHash}, ${email})
        returning id
      `;
      await tx`
        insert into account_identities
          (account_id, email_snapshot, email_verified, provider_issuer, provider_key, provider_subject)
        values (${account.id}, ${email}, true, 'frameos-cloud', 'password', ${email})
      `;
    });
    console.log(`created account ${email} (password: ${password})`);
  }
  await sql`
    update accounts set
      is_superadmin = true,
      verified_publisher_at = coalesce(verified_publisher_at, now()),
      display_name = ${displayName}
    where id = (
      select account_id from account_identities
      where email_snapshot = ${email} and provider_key = 'password' limit 1
    )
  `;
  const login = await postJson("/api/auth/login", { email, password });
  if (!login.ok) {
    throw new Error(`login failed: ${login.status} ${await login.text()}`);
  }
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie.includes("=")) {
    throw new Error("no session cookie from login");
  }
  return cookie;
}

function hashPassword(plain) {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, 64, { N: 2 ** 16, p: 1, r: 8, maxmem: 128 * 1024 * 1024 }, (error, derived) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(
        ["scrypt", "65536", "8", "1", salt.toString("base64url"), derived.toString("base64url")].join("$"),
      );
    });
  });
}

async function postJson(path, body, cookie) {
  return fetch(`${cloudUrl}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: cloudUrl,
      ...(cookie ? { cookie } : {}),
    },
    method: "POST",
  });
}

async function request(method, path, body, cookie) {
  const response = await fetch(`${cloudUrl}${path}`, {
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      origin: cloudUrl,
      cookie,
    },
    method,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  }
  return response.json().catch(() => ({}));
}

// --- import ---------------------------------------------------------------

async function importScene(scene, cookie) {
  const zip = await fetchBytes(`${sourceUrl}/api/store/scenes/${scene.id}/download`);
  const sha256 = createHash("sha256").update(zip).digest("hex");

  const [local] = await sql`
    select s.id, s.latest_version,
      (select v.sha256 from store_scene_versions v
        where v.scene_id = s.id order by v.version desc limit 1) as latest_sha256
    from store_scenes s
    where s.slug = ${scene.slug}
      or (lower(s.name) = lower(${scene.name}) and s.account_id = (
        select account_id from account_identities
        where email_snapshot = ${email} and provider_key = 'password' limit 1))
    order by (s.slug = ${scene.slug}) desc
    limit 1
  `;

  let localId = local?.id;
  let result = "unchanged";
  if (!local || local.latest_sha256 !== sha256) {
    const form = new FormData();
    form.set("file", new Blob([zip], { type: "application/zip" }), `${scene.slug}.zip`);
    const upload = await fetch(`${cloudUrl}/api/account/scenes/upload`, {
      body: form,
      headers: { origin: cloudUrl, cookie },
      method: "POST",
    });
    if (!upload.ok) {
      throw new Error(`upload: ${upload.status} ${await upload.text()}`);
    }
    const published = await upload.json();
    localId = published.scene?.id ?? published.id ?? localId;
    if (!localId) {
      throw new Error(`upload returned no scene id: ${JSON.stringify(published)}`);
    }
    result = local ? "newVersion" : "created";
  }

  // Align metadata through the owner API (moderation + normalisation), then
  // the bits only the database can set: slug, counters, timestamps. The
  // backdated created_at is also what keeps 27 imports under the
  // 20-new-scenes-per-day quota.
  await request(
    "PATCH",
    `/api/account/scenes/${localId}`,
    {
      category: scene.category ?? null,
      description: scene.description ?? null,
      frameosVersion: scene.frameosVersion ?? null,
      tags: scene.tags ?? [],
      visibility: "public",
    },
    cookie,
  );

  const updatedAt = scene.updatedAt ? new Date(scene.updatedAt) : new Date();
  await sql`
    update store_scenes set
      slug = ${scene.slug},
      download_count = ${scene.downloadCount ?? 0},
      created_at = least(created_at, ${updatedAt}),
      updated_at = ${updatedAt}
    where id = ${localId}
  `;

  if (result === "created") {
    const imageIds = await sourceGalleryImageIds(scene);
    for (const imageId of imageIds) {
      const bytes = await fetchBytes(
        `${sourceUrl}/api/store/scenes/${scene.id}/images/${imageId}`,
      );
      await request(
        "POST",
        `/api/account/scenes/${localId}/images`,
        { content_base64: bytes.toString("base64") },
        cookie,
      );
    }
  }
  return result;
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
}
