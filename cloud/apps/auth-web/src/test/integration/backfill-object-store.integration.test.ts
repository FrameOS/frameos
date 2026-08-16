// The one-shot chore that moves blobs written before migration 0032 out of
// Postgres (scripts/backfill-object-store.mjs), run for real: a seeded
// database, the script as a child process, and a directory as the object
// store.
//
// It is tested end to end rather than unit-tested because the bug it shipped
// with was invisible to every smaller test. The first version streamed rows
// with a postgres.js `.cursor()` and issued the UPDATE inside the loop — on a
// pool of one connection, which the cursor holds, so the update queued behind
// a cursor that could not advance until the update ran. Nothing threw. The
// process simply sat there with Postgres reporting `ClientRead` and zero rows
// moved, and it did that against production. A test that runs the script and
// waits for it to exit is what catches that class of bug; the timeout IS the
// assertion.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import {
  createDb,
  frameAssetFiles,
  frames,
  linkedClients,
  storeSceneImages,
  storeScenes,
  storeSceneVersions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const db = createDb();

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/backfill-object-store.mjs",
);

let objectRoot: string;

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = tables
    .map((row) => row.tablename)
    .filter((name) => name !== "schema_migrations")
    .map((name) => `"${name}"`);
  if (names.length > 0) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${names.join(", ")} CASCADE`));
  }
  if (objectRoot) {
    await rm(objectRoot, { force: true, recursive: true });
  }
  objectRoot = await mkdtemp(join(tmpdir(), "frameos-backfill-"));
});

async function backfill(...args: string[]) {
  const { stdout } = await run("node", [scriptPath, ...args], {
    env: {
      ...process.env,
      // No R2 credentials: the filesystem driver is the point here.
      DATABASE_URL: process.env.DATABASE_URL!,
      FRAMEOS_OBJECT_STORE_DIR: objectRoot,
    },
    // Generous, but finite. A deadlocked script fails here rather than
    // hanging the suite.
    timeout: 60_000,
  });
  return JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
}

async function seed() {
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: "Backfill",
    email: `backfill-${Date.now()}@example.com`,
    emailVerified: true,
    providerIssuer: "https://accounts.google.com",
    providerKey: "google",
    providerSubject: `backfill-${Date.now()}`,
  });
  const [scene] = await db
    .insert(storeScenes)
    .values({
      accountId,
      latestVersion: 3,
      name: "Scene",
      previewImage: Buffer.from("preview-bytes"),
      previewImageType: "image/png",
      slug: `scene-${Date.now()}`,
    })
    .returning();
  // Three versions holding IDENTICAL bytes: content-addressed keys mean they
  // must end up sharing one object.
  const versionBytes = Buffer.from("a scene zip, pretend");
  await db.insert(storeSceneVersions).values(
    [1, 2, 3].map((version) => ({
      content: versionBytes,
      sceneId: scene!.id,
      sha256: "seeded",
      sizeBytes: versionBytes.length,
      version,
    })),
  );
  await db.insert(storeSceneImages).values({
    content: Buffer.from("gallery-bytes"),
    contentType: "image/jpeg",
    position: 1,
    sceneId: scene!.id,
  });

  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      publicDisplayName: "Frame",
      tokenReference: `ref-${Date.now()}`,
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      linkedClientId: client!.id,
      name: "Frame",
      publicKey: "pk",
      status: "active",
    })
    .returning();
  const snapshot = Buffer.from("a device snapshot");
  await db.insert(frameAssetFiles).values({
    content: snapshot,
    contentType: "image/png",
    frameId: frame!.id,
    path: ".frameos/scene_images/x.png",
    sizeBytes: snapshot.length,
    thumb: false,
  });
  return { accountId, frame: frame!, scene: scene! };
}

describe("backfill-object-store.mjs", () => {
  it("reports what is left without touching anything", async () => {
    await seed();

    const summary = await backfill();

    expect(summary.dryRun).toBe(true);
    expect(summary.driver).toBe("fs");
    expect(summary.moved).toEqual({
      "frame_asset_files": 1,
      "store_scene_images": 1,
      "store_scene_versions": 3,
      "store_scenes.preview_image": 1,
    });
    // Nothing written, nothing nulled.
    expect(await readdir(objectRoot)).toEqual([]);
    const [version] = await db.select().from(storeSceneVersions).limit(1);
    expect(version!.content).not.toBeNull();
    expect(version!.objectKey).toBeNull();
  });

  it("moves every blob, deduplicates identical ones, and can be re-run", async () => {
    const { frame } = await seed();

    const summary = await backfill("--apply");
    expect(summary.dryRun).toBe(false);
    expect(summary.moved["store_scene_versions"]).toBe(3);

    // Every row now points at an object and holds no bytes.
    const versions = await db.select().from(storeSceneVersions);
    expect(versions).toHaveLength(3);
    for (const version of versions) {
      expect(version.content).toBeNull();
      expect(version.objectKey).toMatch(/^store\/scene-versions\/[0-9a-f]{64}\.zip$/);
    }
    // Identical bytes, one object.
    expect(new Set(versions.map((version) => version.objectKey)).size).toBe(1);
    expect(await readdir(join(objectRoot, "store/scene-versions"))).toHaveLength(1);

    const [scene] = await db.select().from(storeScenes);
    expect(scene!.previewImage).toBeNull();
    expect(scene!.previewObjectKey).toMatch(/^store\/scene-previews\//);
    // The size the accounting reads once the bytes are gone.
    expect(scene!.previewImageSizeBytes).toBe("preview-bytes".length);

    const [galleryImage] = await db.select().from(storeSceneImages);
    expect(galleryImage!.content).toBeNull();
    expect(galleryImage!.sizeBytes).toBe("gallery-bytes".length);

    const [asset] = await db
      .select()
      .from(frameAssetFiles)
      .where(eq(frameAssetFiles.frameId, frame.id));
    expect(asset!.content).toBeNull();
    // Per-frame namespace, so one frame's cache can be swept on its own.
    expect(asset!.objectKey).toMatch(
      new RegExp(`^frames/${frame.id}/cache/[0-9a-f]{64}$`),
    );
    expect((await stat(join(objectRoot, asset!.objectKey!))).size).toBe(
      "a device snapshot".length,
    );

    // Interrupted-and-resumed is the normal case, so a second run must be a
    // no-op rather than a second upload.
    const again = await backfill("--apply");
    expect(again.moved).toEqual({
      "frame_asset_files": 0,
      "store_scene_images": 0,
      "store_scene_versions": 0,
      "store_scenes.preview_image": 0,
    });
  });

  it("leaves rows that already moved alone", async () => {
    await seed();
    await backfill("--apply");
    const [before] = await db.select().from(storeSceneVersions).limit(1);

    // A row written after the move: content null, key set. The backfill must
    // not see it at all.
    const summary = await backfill();
    expect(summary.moved["store_scene_versions"]).toBe(0);
    const [after] = await db
      .select()
      .from(storeSceneVersions)
      .where(eq(storeSceneVersions.id, before!.id));
    expect(after!.objectKey).toBe(before!.objectKey);
  });
});
