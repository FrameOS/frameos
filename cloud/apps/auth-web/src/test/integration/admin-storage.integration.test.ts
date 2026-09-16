// The /admin/storage snapshot (src/lib/storage-usage.ts): what it measures,
// what it writes, and what the page reads back. The point of the table is
// that the page never runs these aggregates itself, so the thing worth
// testing is that the stored numbers equal the live ones — including the two
// buckets no quota measures (retained metrics, the device asset cache).
import { generateKeyPairSync } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  accountStorageUsage,
  clientBackups,
  createDb,
  frameAssetFiles,
  frameLogs,
  frameMetrics,
  frames,
  linkedClients,
  storeScenes,
  storeSceneVersions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashSecret } from "../../lib/secrets";
import {
  listAccountStorageForAdmin,
  measureAccountStorage,
  refreshAccountStorageUsage,
  storageRefreshDue,
  storageSnapshotIsStale,
  storageSnapshotSummary,
} from "../../lib/storage-usage";

const issuer = "https://accounts.google.com";
const db = createDb();
let userCounter = 0;

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
});

async function createAccount() {
  userCounter += 1;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Storage Tester ${userCounter}`,
    email: `storage-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject: `storage-user-${userCounter}`,
  });
  return accountId;
}

async function seedScene(
  accountId: string,
  visibility: "private" | "public",
  sizeBytes: number,
) {
  const [scene] = await db
    .insert(storeScenes)
    .values({
      accountId,
      latestVersion: 1,
      name: `Storage ${visibility} ${userCounter}-${sizeBytes}`,
      slug: `storage-${visibility}-${userCounter}-${sizeBytes}`,
      status: "active",
      visibility,
    })
    .returning();
  await db.insert(storeSceneVersions).values({
    content: Buffer.from("tiny"),
    contentType: "application/zip",
    sceneId: scene!.id,
    sha256: `storage-${scene!.id}`,
    sizeBytes,
    version: 1,
  });
  return scene!;
}

function rawPublicKeyBase64() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

async function seedFrame(accountId: string, suffix = "") {
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: ["frame:managed"] },
      publicDisplayName: "Storage frame",
      tokenReference: hashSecret(`fc_link_storage_${accountId}${suffix}`),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      linkedClientId: client!.id,
      name: "Storage frame",
      publicKey: rawPublicKeyBase64(),
      status: "active",
    })
    .returning();
  return frame!;
}

// One account carrying a little of everything, so every bucket is non-zero
// and a bucket wired to the wrong column shows up as a wrong number rather
// than as another zero.
async function seedEverything(accountId: string) {
  await seedScene(accountId, "private", 5_000);
  await seedScene(accountId, "public", 3_000);
  await db.insert(clientBackups).values([
    {
      accountId,
      content: Buffer.from("backup-one"),
      itemKey: "frame-1",
      kind: "frame",
      sha256: `backup-one-${accountId}`,
      sizeBytes: 700,
    },
    {
      accountId,
      content: Buffer.from("backup-two"),
      itemKey: "frame-2",
      kind: "frame",
      sha256: `backup-two-${accountId}`,
      sizeBytes: 300,
    },
  ]);
  const frame = await seedFrame(accountId);
  await db.insert(frameLogs).values({
    frameId: frame.id,
    payload: { line: "hello" },
    sizeBytes: 120,
    timestamp: new Date(),
  });
  await db.insert(frameMetrics).values({
    frameId: frame.id,
    payload: { cpu: 1 },
    sizeBytes: 60,
    timestamp: new Date(),
  });
  await db.insert(frameAssetFiles).values({
    content: Buffer.from("cached"),
    contentType: "image/png",
    frameId: frame.id,
    path: "images/one.png",
    sizeBytes: 40,
  });
  return {
    backupBytes: 1_000,
    backupCount: 2,
    frameAssetBytes: 40,
    frameLogBytes: 120,
    frameMetricsBytes: 60,
    privateSceneBytes: 5_000,
    publicSceneBytes: 3_000,
    totalBytes: 5_000 + 3_000 + 1_000 + 120 + 60 + 40,
  };
}

describe("account storage snapshot", () => {
  it("measures every bucket, including the ones no quota counts", async () => {
    const accountId = await createAccount();
    const expected = await seedEverything(accountId);

    expect(await measureAccountStorage(db, accountId)).toEqual(expected);
  });

  it("writes the measured numbers to the snapshot table", async () => {
    const accountId = await createAccount();
    const expected = await seedEverything(accountId);

    const result = await refreshAccountStorageUsage(db);
    expect(result.accounts).toBe(1);
    expect(result.failed).toBe(0);

    const [row] = await db
      .select()
      .from(accountStorageUsage)
      .where(eq(accountStorageUsage.accountId, accountId));
    expect(row).toMatchObject({
      backupBytes: expected.backupBytes,
      backupCount: expected.backupCount,
      frameAssetBytes: expected.frameAssetBytes,
      frameLogBytes: expected.frameLogBytes,
      frameMetricsBytes: expected.frameMetricsBytes,
      privateSceneBytes: expected.privateSceneBytes,
      publicSceneBytes: expected.publicSceneBytes,
      totalBytes: expected.totalBytes,
    });

    const summary = await storageSnapshotSummary(db);
    expect(summary.totalBytes).toBe(expected.totalBytes);
    expect(summary.computedAt).toBeInstanceOf(Date);
  });

  it("lists the biggest account first and totals the whole instance", async () => {
    const small = await createAccount();
    await seedScene(small, "private", 1_000);
    const large = await createAccount();
    const expected = await seedEverything(large);

    await refreshAccountStorageUsage(db);
    const overview = await listAccountStorageForAdmin(db);

    expect(overview.rows.map((row) => row.accountId)).toEqual([large, small]);
    expect(overview.rows[0]!.totalBytes).toBe(expected.totalBytes);
    expect(overview.totals.totalBytes).toBe(expected.totalBytes + 1_000);
    expect(overview.missing).toBe(0);
    expect(storageSnapshotIsStale(overview)).toBe(false);
  });

  it("counts an account created since the last sweep as unmeasured", async () => {
    const measured = await createAccount();
    await seedScene(measured, "private", 1_000);
    await refreshAccountStorageUsage(db);

    const fresh = await createAccount();
    const overview = await listAccountStorageForAdmin(db);

    expect(overview.missing).toBe(1);
    expect(storageSnapshotIsStale(overview)).toBe(true);
    // Stale, but this process just swept: the page must not start another
    // full sweep on every load to retry one account.
    expect(storageRefreshDue(overview)).toBe(false);
    const row = overview.rows.find((entry) => entry.accountId === fresh);
    expect(row?.computedAt).toBeNull();
    expect(row?.totalBytes).toBe(0);
  });

  it("filters by email and keeps the totals instance-wide", async () => {
    const first = await createAccount();
    await seedScene(first, "private", 2_000);
    const second = await createAccount();
    await seedScene(second, "private", 4_000);
    await refreshAccountStorageUsage(db);

    // createAccount() numbers its emails, so the last one made is `second`.
    const overview = await listAccountStorageForAdmin(
      db,
      `storage-${userCounter}@example.com`,
    );
    expect(overview.rows.map((row) => row.accountId)).toEqual([second]);
    // The search narrows the rows, never the instance total.
    expect(overview.totals.totalBytes).toBe(6_000);
  });

  it("drops an account's snapshot when the account is deleted", async () => {
    const accountId = await createAccount();
    await seedScene(accountId, "private", 1_000);
    await refreshAccountStorageUsage(db);

    await db.execute(sql`delete from accounts where id = ${accountId}`);
    const rows = await db.select().from(accountStorageUsage);
    expect(rows).toHaveLength(0);
  });
});
