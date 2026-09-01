// Per-account storage quotas (src/lib/usage.ts): private scenes are metered,
// public scenes are free, backups refuse over budget, frame logs cull their
// oldest lines instead. Sizes are seeded via the size_bytes columns — the
// same numbers the accounting sums — so no test ships hundreds of megabytes.
import { generateKeyPairSync } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  clientBackups,
  createDb,
  frameLogs,
  frames,
  linkedClients,
  storeScenes,
  storeSceneVersions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getGrants } from "../../../app/api/backends/grants/route";
import { POST as saveBackup } from "../../../app/api/backends/backups/route";
import { POST as createScene } from "../../../app/api/account/scenes/route";
import { POST as authorizeDevice } from "../../../app/api/device/authorize/route";
import { POST as pollDevice } from "../../../app/api/device/poll/route";
import { POST as startDevice } from "../../../app/api/device/start/route";
import { storeFrameLogs } from "../../lib/frames";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { hashSecret } from "../../lib/secrets";
import { createSession, sessionCookieName } from "../../lib/session";
import { recordAiUsage } from "@frameos-cloud/ledger";
import { resolveAiAccess } from "../../lib/ai/api-key";
import {
  accountUsage,
  maxBackupBytesPerAccount,
  maxFrameLogBytesPerAccount,
  maxPrivateSceneBytesPerAccount,
} from "../../lib/usage";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => new Headers(),
}));

const baseUrl = "http://localhost:3000";
const issuer = "https://accounts.google.com";
const db = createDb();
let userCounter = 0;

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  resetRateLimitForTests();
  cookieJar.clear();
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

function postJson(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return new NextRequest(new URL(path, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: baseUrl, ...headers },
    method: "POST",
  });
}

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function signIn() {
  userCounter += 1;
  const providerSubject = `usage-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Usage Tester ${userCounter}`,
    email: `usage-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject,
  });
  const token = await createSession(db, {
    accountId,
    providerIssuer: issuer,
    providerSubject,
  });
  cookieJar.set(sessionCookieName, token);
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
      name: `Seeded ${visibility} ${userCounter}-${sizeBytes}`,
      slug: `seeded-${visibility}-${userCounter}-${sizeBytes}`,
      status: "active",
      visibility,
    })
    .returning();
  // Bytes are billed per distinct digest, so each seeded version needs a
  // digest of its own — two scenes with the same zip really would share.
  await db.insert(storeSceneVersions).values({
    content: Buffer.from("tiny"),
    contentType: "application/zip",
    sceneId: scene!.id,
    sha256: `seeded-${scene!.id}`,
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

async function seedFrame(accountId: string) {
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: ["frame:managed"] },
      publicDisplayName: "Usage frame",
      tokenReference: hashSecret(`fc_link_usage_${accountId}`),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      linkedClientId: client!.id,
      name: "Usage frame",
      publicKey: rawPublicKeyBase64(),
      status: "active",
    })
    .returning();
  return frame!;
}

async function linkBackend() {
  const startResponse = await startDevice(
    postJson("/api/device/start", {
      local_origin: "http://10.2.2.2:8989",
      public_display_name: "Usage Backend",
      scopes: ["backend:link", "backup:frames"],
    }),
  );
  const startPayload = await readJson(startResponse);
  const accountId = await signIn();
  const authorizeResponse = await authorizeDevice(
    postJson("/api/device/authorize", { user_code: startPayload.user_code }),
  );
  expect(authorizeResponse.status).toBe(200);
  const pollResponse = await pollDevice(
    postJson("/api/device/poll", { device_code: startPayload.device_code }),
  );
  expect(pollResponse.status).toBe(200);
  const { access_token: accessToken } = await readJson(pollResponse);
  return { accessToken: accessToken as string, accountId };
}

// The daily cap (cloud/docs/accounting-todo.md §5.3) refuses AT the cap; the
// overdraft is how far a turn already running may overshoot, not extra
// headroom for the next one. The gate used to refuse at cap + overdraft,
// which made the real cap $11 and every honest overshoot a nightly alert
// (§9.2 item 3).
describe("the daily AI cap", () => {
  const env = { FRAMEOS_AI_SHARED_KEY_ACCESS: "all", OPENAI_API_KEY: "sk-shared" };
  const turn = (accountId: string, n: number) =>
    recordAiUsage(db, {
      accountId,
      credentialSource: "shared",
      model: "gpt-5.6-terra",
      surface: "scene_chat",
      turnId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      // 442,400 of provider cost; 575,120 at the 30% fallback margin the
      // tests' empty plan table leaves in force.
      usage: { cachedInputTokens: 12_000, inputTokens: 52_000, outputTokens: 30_000 },
    });

  it("lets a turn start under the cap and refuses at it", async () => {
    const accountId = await signIn();
    // 17 turns: 9,777,040 — under the $10 default cap, with the budget the
    // runner keeps checking against handed back.
    for (let n = 1; n <= 17; n += 1) {
      await turn(accountId, n);
    }
    const under = await resolveAiAccess(db, accountId, { env, surface: "scene_chat" });
    expect(under.ok).toBe(true);
    if (under.ok) {
      expect(under.budget).toMatchObject({
        capMicros: 10_000_000n,
        overdraftMicros: 1_000_000n,
        spentMicros: 9_777_040n,
      });
    }

    // One more: 10,352,160 — past the cap but inside cap + overdraft, which
    // the old gate would still have let through.
    await turn(accountId, 18);
    const over = await resolveAiAccess(db, accountId, { env, surface: "scene_chat" });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.refusal).toMatchObject({
        capMicros: "10000000",
        reason: "daily_cap_reached",
        spentMicros: "10352160",
      });
    }
    // An absorbed surface is never refused by the cap.
    const absorbed = await resolveAiAccess(db, accountId, { env, surface: "scene_convert" });
    expect(absorbed.ok).toBe(true);
  });
});

describe("account storage usage and quotas", () => {
  it("splits scene bytes by visibility — public scenes are free", async () => {
    const accountId = await signIn();
    await seedScene(accountId, "private", 5_000_000);
    await seedScene(accountId, "public", 50_000_000);

    const usage = await accountUsage(db, accountId);
    expect(usage.scenes.private_bytes).toBe(5_000_000);
    expect(usage.scenes.public_bytes).toBe(50_000_000);
    expect(usage.scenes.private_max_bytes).toBe(maxPrivateSceneBytesPerAccount);
    expect(usage.backups.max_bytes).toBe(maxBackupBytesPerAccount);
    expect(usage.frame_logs.max_bytes).toBe(maxFrameLogBytesPerAccount);
  });

  it("refuses a new private scene over the private byte quota", async () => {
    const accountId = await signIn();
    await seedScene(accountId, "private", maxPrivateSceneBytesPerAccount);

    const response = await createScene(
      postJson("/api/account/scenes", {
        name: "One scene too many",
        scenes: [{ edges: [], id: "s1", name: "One scene too many", nodes: [] }],
      }),
    );
    expect(response.status).toBe(403);
    expect((await readJson(response)).error).toBe("storage_quota_exceeded");
  });

  it("ignores public bytes when metering a new private scene", async () => {
    const accountId = await signIn();
    // Way past the quota — but public, so free.
    await seedScene(accountId, "public", maxPrivateSceneBytesPerAccount * 2);

    const response = await createScene(
      postJson("/api/account/scenes", {
        name: "Fits fine",
        scenes: [{ edges: [], id: "s1", name: "Fits fine", nodes: [] }],
      }),
    );
    expect(response.status).toBe(200);
  });

  it("enforces the backup byte quota, letting same-key replacements through", async () => {
    const { accessToken, accountId } = await linkBackend();
    // Fill the budget with one fat row (size_bytes is what the meter sums).
    await db.insert(clientBackups).values({
      accountId,
      content: Buffer.from("tiny"),
      itemKey: "existing",
      kind: "frames",
      linkedClientId: (
        await db
          .select({ id: linkedClients.id })
          .from(linkedClients)
          .where(eq(linkedClients.accountId, accountId))
      )[0]!.id,
      sha256: "seeded",
      sizeBytes: maxBackupBytesPerAccount - 2,
    });

    const refused = await saveBackup(
      postJson(
        "/api/backends/backups",
        {
          content_base64: Buffer.from("abcdef").toString("base64"),
          item_key: "new-item",
          kind: "frames",
        },
        { authorization: `Bearer ${accessToken}` },
      ),
    );
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).error).toBe(
      "backup_storage_quota_exceeded",
    );

    // Replacing the existing key only counts the delta, so a small payload
    // under the freed size passes.
    const replaced = await saveBackup(
      postJson(
        "/api/backends/backups",
        {
          content_base64: Buffer.from("ok").toString("base64"),
          item_key: "existing",
          kind: "frames",
        },
        { authorization: `Bearer ${accessToken}` },
      ),
    );
    expect(replaced.status).toBe(200);
  });

  it("culls the oldest frame logs across the account instead of refusing", async () => {
    const accountId = await signIn();
    const frame = await seedFrame(accountId);
    // Three fat rows, oldest first: 40 + 40 + 40 MiB > the 100 MiB budget.
    const fat = Math.floor(maxFrameLogBytesPerAccount * 0.4);
    for (const label of ["oldest", "middle", "newest"]) {
      await db.insert(frameLogs).values({
        frameId: frame.id,
        payload: { label },
        sizeBytes: fat,
        timestamp: new Date(),
      });
    }

    const stored = await storeFrameLogs(
      db,
      frame.id,
      [{ payload: { line: "fresh" }, timestamp: new Date() }],
      accountId,
    );
    expect(stored).toBe(1);

    const remaining = await db
      .select({ payload: frameLogs.payload, sizeBytes: frameLogs.sizeBytes })
      .from(frameLogs)
      .where(eq(frameLogs.frameId, frame.id))
      .orderBy(frameLogs.id);
    const totalBytes = remaining.reduce((sum, row) => sum + row.sizeBytes, 0);
    expect(totalBytes).toBeLessThanOrEqual(maxFrameLogBytesPerAccount);
    const labels = remaining.map(
      (row) => (row.payload as Record<string, unknown>).label ?? "fresh",
    );
    expect(labels).not.toContain("oldest");
    expect(labels).toContain("newest");
    expect(labels).toContain("fresh");
  });

  it("reports usage with limits on the grants poll", async () => {
    const { accessToken, accountId } = await linkBackend();
    await seedScene(accountId, "private", 1_234_567);

    const response = await getGrants(
      new NextRequest(new URL("/api/backends/grants", baseUrl), {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    );
    expect(response.status).toBe(200);
    const payload = await readJson(response);
    const usage = payload.usage as {
      scenes: { private_bytes: number; private_max_bytes: number };
    };
    expect(usage.scenes.private_bytes).toBe(1_234_567);
    expect(usage.scenes.private_max_bytes).toBe(maxPrivateSceneBytesPerAccount);
  });
});
