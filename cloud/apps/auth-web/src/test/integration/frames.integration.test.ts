import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import { NextRequest } from "next/server";
import {
  createDb,
  frameCommands,
  frameEnrollmentTokens,
  frameLogs,
  frames,
  frameSceneAssignments,
  linkedClients,
  storeScenes,
  storeSceneVersions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as mintClaimToken } from "../../../app/api/frames/claim-tokens/route";
import { POST as enrollFrame } from "../../../app/api/frames/enroll/route";
import { GET as listFrames } from "../../../app/api/frames/route";
import { POST as sendCommand } from "../../../app/api/frames/[frameId]/command/route";
import { POST as confirmFrame } from "../../../app/api/frames/[frameId]/confirm/route";
import { GET as getFrameLogs } from "../../../app/api/frames/[frameId]/logs/route";
import { GET as getFrameLogsFull } from "../../../app/api/frames/[frameId]/logs/full/route";
import { POST as revokeFrameRoute } from "../../../app/api/frames/[frameId]/revoke/route";
import {
  GET as getFrameScenes,
  POST as assignFrameScenes,
} from "../../../app/api/frames/[frameId]/scenes/route";
import { POST as pushFrameSettings } from "../../../app/api/frames/[frameId]/settings/route";
import { GET as getFrameDetail } from "../../../app/api/frames/[frameId]/route";
import {
  allowedFrameSettings,
  maxClaimTokensPerAccount,
  maxFramesPerAccount,
  maxScenesPayloadBytes,
  verifyFrameSignature,
} from "../../lib/frames";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { hashSecret } from "../../lib/secrets";
import { createSession, sessionCookieName } from "../../lib/session";

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
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

function getRequest(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(path, baseUrl), { headers, method: "GET" });
}

const routeParams = (frameId: string) => ({
  params: Promise.resolve({ frameId }),
});

async function signIn() {
  userCounter += 1;
  const providerSubject = `frame-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Frames User ${userCounter}`,
    email: `frames-${userCounter}@example.com`,
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

function deviceKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  // Raw key = last 32 bytes of the SPKI structure.
  const rawPublic = Buffer.from(spki.subarray(spki.length - 32));
  return {
    privateKey,
    publicKeyBase64: rawPublic.toString("base64"),
    sign: (message: Buffer) =>
      cryptoSign(null, message, privateKey).toString("base64"),
  };
}

async function mintToken(name?: string) {
  const response = await mintClaimToken(
    postJson("/api/frames/claim-tokens", name ? { name } : {}, {
      origin: baseUrl,
    }),
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { claim_token: string };
  return payload.claim_token;
}

async function enroll(
  claimToken: string,
  publicKeyBase64: string,
  extra: Record<string, unknown> = {},
) {
  return enrollFrame(
    postJson("/api/frames/enroll", {
      claim_token: claimToken,
      frameos_version: "2026.8.1",
      hardware: { height: 480, platform: "pi-zero2w", width: 800 },
      public_key: publicKeyBase64,
      ...extra,
    }),
  );
}

async function enrolledFrame() {
  const accountId = await signIn();
  const keys = deviceKeypair();
  const claimToken = await mintToken("Kitchen frame");
  const response = await enroll(claimToken, keys.publicKeyBase64);
  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    access_token: string;
    frame_id: string;
    status: string;
  };
  return { accountId, keys, ...payload };
}

// Fill an account up to `count` frames without going through enrollment, so
// quota tests do not need `count` round trips through the route.
async function seedFrames(accountId: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    const [client] = await db
      .insert(linkedClients)
      .values({
        accountId,
        clientKind: "frame",
        providerClientMetadata: { requestedScopes: ["frame:managed"] },
        publicDisplayName: `Seeded frame ${index}`,
        tokenReference: hashSecret(`fc_link_seed_${accountId}_${index}`),
      })
      .returning();
    await db.insert(frames).values({
      accountId,
      linkedClientId: client!.id,
      name: `Seeded frame ${index}`,
      publicKey: deviceKeypair().publicKeyBase64,
      status: "active",
    });
  }
}

async function claimTokenUseCount(claimToken: string) {
  const [row] = await db
    .select()
    .from(frameEnrollmentTokens)
    .where(eq(frameEnrollmentTokens.tokenHash, hashSecret(claimToken)));
  return row?.useCount ?? -1;
}

function sceneZip(sceneId: string) {
  const scenes = [
    {
      edges: [],
      id: sceneId,
      name: `Scene ${sceneId}`,
      nodes: [],
    },
  ];
  return Buffer.from(
    zipSync({
      "scene/scenes.json": new TextEncoder().encode(JSON.stringify(scenes)),
      "scene/template.json": new TextEncoder().encode(
        JSON.stringify({ name: `Scene ${sceneId}` }),
      ),
    }),
  );
}

// Mirrors what store-publish.ts writes: risk flags live on the version, and
// store_scenes.risk_flags is only a denormalized copy of the LATEST version's.
async function createStoreScene(
  accountId: string,
  options: {
    name: string;
    riskFlags?: string[];
    visibility?: "private" | "public";
  },
) {
  const [scene] = await db
    .insert(storeScenes)
    .values({
      accountId,
      latestVersion: 1,
      name: options.name,
      riskFlags: options.riskFlags ?? [],
      slug: options.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      status: "active",
      visibility: options.visibility ?? "private",
    })
    .returning();
  if (!scene) {
    throw new Error("scene insert failed");
  }
  await db.insert(storeSceneVersions).values({
    content: sceneZip(scene.id),
    contentType: "application/zip",
    riskFlags: options.riskFlags ?? [],
    sceneId: scene.id,
    sha256: "test",
    sizeBytes: 1000,
    version: 1,
  });
  return scene;
}

// Publish another version of an existing scene, exactly as store-publish
// does: a new immutable version row plus store_scenes.risk_flags overwritten
// with the new version's flags.
async function publishSceneVersion(
  sceneId: string,
  version: number,
  riskFlags: string[] = [],
) {
  await db.insert(storeSceneVersions).values({
    content: sceneZip(`${sceneId}-v${version}`),
    contentType: "application/zip",
    riskFlags,
    sceneId,
    sha256: `test-v${version}`,
    sizeBytes: 1000,
    version,
  });
  await db
    .update(storeScenes)
    .set({ latestVersion: version, riskFlags })
    .where(eq(storeScenes.id, sceneId));
}

describe("cloud-managed frame enrollment", () => {
  it("enrolls with a claim token, single-use, pending until confirmed", async () => {
    const accountId = await signIn();
    const keys = deviceKeypair();
    const claimToken = await mintToken("Kitchen frame");
    expect(claimToken.startsWith("FRCT_")).toBe(true);

    const response = await enroll(claimToken, keys.publicKeyBase64);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.status).toBe("pending");
    expect(payload.token_type).toBe("Bearer");
    // The FULL grant, not just frame:managed — the device stores this string
    // as its local scope list and gates its telemetry push loops on it.
    expect(payload.scope).toBe(
      "frame:managed telemetry:logs telemetry:metrics",
    );
    expect(payload.ws_path).toBe("/api/frames/ws");
    expect(typeof payload.access_token).toBe("string");

    // The linked client is real and carries the claim-token grant.
    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.accountId, accountId));
    expect(frame?.name).toBe("Kitchen frame");
    expect(frame?.publicKey).toBe(keys.publicKeyBase64);
    const [client] = await db
      .select()
      .from(linkedClients)
      .where(eq(linkedClients.id, frame!.linkedClientId));
    expect(client?.clientKind).toBe("frame");

    // Single use: replaying the claim token fails.
    const replay = await enroll(claimToken, deviceKeypair().publicKeyBase64);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe(
      "invalid_claim_token",
    );

    // Confirm: pending → active.
    const confirm = await confirmFrame(
      postJson(`/api/frames/${frame!.id}/confirm`, {}, { origin: baseUrl }),
      routeParams(frame!.id),
    );
    expect(confirm.status).toBe(200);
    const [confirmed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame!.id));
    expect(confirmed?.status).toBe("active");
  });

  // ws_url is the device-side analogue of the SPA's cloud_ws_origin
  // injection (app/frames/[[...path]]/route.test.ts): present only when the
  // management WebSocket lives somewhere other than {cloud_url}{ws_path}.
  it("offers ws_url from FRAME_HUB_PUBLIC_URL, ws-scheme, trailing slash and all", async () => {
    await signIn();
    process.env.FRAME_HUB_PUBLIC_URL = "https://hub.frameos.net/";
    try {
      const claimToken = await mintToken();
      const response = await enroll(claimToken, deviceKeypair().publicKeyBase64);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.ws_path).toBe("/api/frames/ws");
      expect(payload.ws_url).toBe("wss://hub.frameos.net/api/frames/ws");
    } finally {
      delete process.env.FRAME_HUB_PUBLIC_URL;
    }
  });

  it("defaults ws_url to the dev hub port for loopback request hosts", async () => {
    // baseUrl is http://localhost:3000 — a dev server, where nothing on the
    // request origin speaks WebSocket; the hub is a second process on :3100.
    await signIn();
    const claimToken = await mintToken();
    const response = await enroll(claimToken, deviceKeypair().publicKeyBase64);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.ws_url).toBe("ws://localhost:3100/api/frames/ws");
  });

  it("omits ws_url for a public host without FRAME_HUB_PUBLIC_URL", async () => {
    // In production nginx proxies ws_path on the same origin, so the default
    // contract needs no override — and we never guess a second port there.
    await signIn();
    const claimToken = await mintToken();
    const response = await enrollFrame(
      new NextRequest(new URL("/api/frames/enroll", "https://cloud.frameos.net"), {
        body: JSON.stringify({
          claim_token: claimToken,
          public_key: deviceKeypair().publicKeyBase64,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.ws_path).toBe("/api/frames/ws");
    expect("ws_url" in payload).toBe(false);
  });

  it("multi-use claim tokens enroll distinct frames until the budget is spent", async () => {
    const accountId = await signIn();
    const mintResponse = await mintClaimToken(
      postJson(
        "/api/frames/claim-tokens",
        { max_uses: 2, name: "SD batch" },
        { origin: baseUrl },
      ),
    );
    expect(mintResponse.status).toBe(200);
    const minted = (await mintResponse.json()) as {
      claim_token: string;
      max_uses: number;
    };
    expect(minted.max_uses).toBe(2);

    // Two cards flashed from the same image: two distinct frames, each with
    // its own device keypair, each individually pending.
    const first = await enroll(minted.claim_token, deviceKeypair().publicKeyBase64);
    expect(first.status).toBe(200);
    const second = await enroll(minted.claim_token, deviceKeypair().publicKeyBase64);
    expect(second.status).toBe(200);
    const firstPayload = (await first.json()) as { frame_id: string };
    const secondPayload = (await second.json()) as { frame_id: string };
    expect(firstPayload.frame_id).not.toBe(secondPayload.frame_id);

    const rows = await db
      .select()
      .from(frames)
      .where(eq(frames.accountId, accountId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "pending")).toBe(true);
    expect(rows[0]?.publicKey).not.toBe(rows[1]?.publicKey);

    // The budget is spent: the third card gets invalid_claim_token.
    const third = await enroll(minted.claim_token, deviceKeypair().publicKeyBase64);
    expect(third.status).toBe(400);
    expect(((await third.json()) as { error: string }).error).toBe(
      "invalid_claim_token",
    );

    // Bad budgets are refused.
    const badMint = await mintClaimToken(
      postJson("/api/frames/claim-tokens", { max_uses: 0 }, { origin: baseUrl }),
    );
    expect(badMint.status).toBe(400);
  });

  it("ttl_days stretches the claim code expiry for SD images, within bounds", async () => {
    await signIn();
    const mintResponse = await mintClaimToken(
      postJson(
        "/api/frames/claim-tokens",
        { multi_use: true, ttl_days: 90 },
        { origin: baseUrl },
      ),
    );
    expect(mintResponse.status).toBe(200);
    const minted = (await mintResponse.json()) as { expires_at: string };
    const days =
      (new Date(minted.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);

    // "forever" mints a code ~100 years out — effectively never expiring,
    // without a nullable expires_at special case in sweep/redeem.
    const foreverMint = await mintClaimToken(
      postJson(
        "/api/frames/claim-tokens",
        { multi_use: true, ttl_days: "forever" },
        { origin: baseUrl },
      ),
    );
    expect(foreverMint.status).toBe(200);
    const forever = (await foreverMint.json()) as { expires_at: string };
    expect(new Date(forever.expires_at).getFullYear()).toBeGreaterThan(
      new Date().getFullYear() + 90,
    );

    for (const bad of [0, 366, 1.5, "90"]) {
      const badMint = await mintClaimToken(
        postJson(
          "/api/frames/claim-tokens",
          { multi_use: true, ttl_days: bad },
          { origin: baseUrl },
        ),
      );
      expect(badMint.status).toBe(400);
      expect(((await badMint.json()) as { error: string }).error).toBe(
        "invalid_ttl_days",
      );
    }
  });

  it("recycles the oldest unused claim code at the cap instead of locking the account out", async () => {
    const accountId = await signIn();
    // Codes are stored hashed, so an outstanding one can never be shown again.
    // Filling the cap with unused single-use codes must not block minting.
    const minted: string[] = [];
    for (let index = 0; index < maxClaimTokensPerAccount; index += 1) {
      minted.push(await mintToken(`code ${index}`));
    }
    const before = await db
      .select()
      .from(frameEnrollmentTokens)
      .where(eq(frameEnrollmentTokens.accountId, accountId));
    expect(before).toHaveLength(maxClaimTokensPerAccount);

    const next = await mintToken("one more");
    expect(next.startsWith("FRCT_")).toBe(true);

    // Still bounded, and it is the OLDEST code that gave way.
    const after = await db
      .select()
      .from(frameEnrollmentTokens)
      .where(eq(frameEnrollmentTokens.accountId, accountId));
    expect(after).toHaveLength(maxClaimTokensPerAccount);
    const survivingHashes = new Set(after.map((row) => row.tokenHash));
    expect(survivingHashes.has(hashSecret(minted[0]!))).toBe(false);
    expect(survivingHashes.has(hashSecret(minted[1]!))).toBe(true);
    expect(survivingHashes.has(hashSecret(next))).toBe(true);

    // The recycled code is genuinely dead.
    const stale = await enroll(minted[0]!, deviceKeypair().publicKeyBase64);
    expect(stale.status).toBe(400);
    expect(((await stale.json()) as { error: string }).error).toBe(
      "invalid_claim_token",
    );
  });

  it("never recycles a multi-use SD-image code, and says so when the cap is all images", async () => {
    await signIn();
    // A flashed card may still be waiting to enrol; those codes are the
    // enrollment path, so they are held even at the cap.
    for (let index = 0; index < maxClaimTokensPerAccount; index += 1) {
      const response = await mintClaimToken(
        postJson(
          "/api/frames/claim-tokens",
          { max_uses: 2, name: `image ${index}` },
          { origin: baseUrl },
        ),
      );
      expect(response.status).toBe(200);
    }

    const refused = await mintClaimToken(
      postJson("/api/frames/claim-tokens", {}, { origin: baseUrl }),
    );
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "claim_token_quota_exceeded",
    );
  });

  it("rejects garbage public keys and unknown claim tokens", async () => {
    await signIn();
    const claimToken = await mintToken();
    const badKey = await enroll(claimToken, "not-a-key");
    expect(badKey.status).toBe(400);
    expect(((await badKey.json()) as { error: string }).error).toBe(
      "invalid_public_key",
    );
    // The bad-key attempt must NOT have burned the token: key validation
    // happens before redemption, and a use is spent only by an enrollment
    // that actually commits.
    const good = await enroll(claimToken, deviceKeypair().publicKeyBase64);
    expect(good.status).toBe(200);

    const unknown = await enroll(
      "FRCT_doesnotexist",
      deviceKeypair().publicKeyBase64,
    );
    expect(unknown.status).toBe(400);
  });

  it("keeps the device the only holder of the private key (signature roundtrip)", async () => {
    const { keys } = await enrolledFrame();
    const nonce = Buffer.from("nonce-bytes-for-challenge-response!!");
    const signature = keys.sign(nonce);
    expect(verifyFrameSignature(keys.publicKeyBase64, nonce, signature)).toBe(
      true,
    );
    expect(
      verifyFrameSignature(
        deviceKeypair().publicKeyBase64,
        nonce,
        signature,
      ),
    ).toBe(false);
  });

  it("registers a device-flow linked frame as active (flow B) and pins the key", async () => {
    const accountId = await signIn();
    const keys = deviceKeypair();
    const token = `fc_link_${"a".repeat(40)}`;
    const { hashSecret } = await import("../../lib/secrets");
    await db.insert(linkedClients).values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: {
        requestedScopes: ["frame:link", "frame:managed"],
      },
      publicDisplayName: "Hallway frame",
      tokenReference: hashSecret(token),
    });

    const response = await enrollFrame(
      postJson(
        "/api/frames/enroll",
        {
          hardware: { platform: "pi-zero2w" },
          public_key: keys.publicKeyBase64,
        },
        { authorization: `Bearer ${token}` },
      ),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.status).toBe("active");
    expect(payload.access_token).toBeUndefined();

    // Re-registering with a different key is refused — a stolen bearer token
    // must not be able to swap the device identity.
    const swap = await enrollFrame(
      postJson(
        "/api/frames/enroll",
        { public_key: deviceKeypair().publicKeyBase64 },
        { authorization: `Bearer ${token}` },
      ),
    );
    expect(swap.status).toBe(409);
  });

  it("does not spend a claim-token use when the account is over quota", async () => {
    // A device treats the 4xx as permanent and erases its claim token, so an
    // enrollment that never created a frame must leave the budget intact —
    // otherwise the SD card is permanently unenrollable.
    const accountId = await signIn();
    // Minted first: "Add frame" refuses to mint at quota, but a token minted
    // earlier (or an SD card flashed weeks ago) still shows up at the door.
    const claimToken = await mintToken("Over quota");
    await seedFrames(accountId, maxFramesPerAccount);

    const refused = await enroll(claimToken, deviceKeypair().publicKeyBase64);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "frame_quota_exceeded",
    );
    expect(await claimTokenUseCount(claimToken)).toBe(0);
    expect(
      await db.select().from(frames).where(eq(frames.accountId, accountId)),
    ).toHaveLength(maxFramesPerAccount);

    // Free a slot and the very same token still enrolls.
    const [victim] = await db
      .select()
      .from(frames)
      .where(eq(frames.accountId, accountId))
      .limit(1);
    await db.delete(frames).where(eq(frames.id, victim!.id));

    const accepted = await enroll(claimToken, deviceKeypair().publicKeyBase64);
    expect(accepted.status).toBe(200);
    expect(await claimTokenUseCount(claimToken)).toBe(1);
  });

  it("concurrent enrollments on a multi-use token cannot exceed the quota", async () => {
    const accountId = await signIn();
    await seedFrames(accountId, maxFramesPerAccount - 1);
    const mintResponse = await mintClaimToken(
      postJson(
        "/api/frames/claim-tokens",
        { max_uses: 3, name: "Race" },
        { origin: baseUrl },
      ),
    );
    expect(mintResponse.status).toBe(200);
    const { claim_token: claimToken } = (await mintResponse.json()) as {
      claim_token: string;
    };

    const responses = await Promise.all([
      enroll(claimToken, deviceKeypair().publicKeyBase64),
      enroll(claimToken, deviceKeypair().publicKeyBase64),
      enroll(claimToken, deviceKeypair().publicKeyBase64),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 403, 403]);

    const rows = await db
      .select()
      .from(frames)
      .where(eq(frames.accountId, accountId));
    expect(rows).toHaveLength(maxFramesPerAccount);
    // Only the enrollment that committed spent a use.
    expect(await claimTokenUseCount(claimToken)).toBe(1);
  });

  it("is idempotent on (claim token, public key) when the response is lost", async () => {
    const accountId = await signIn();
    const keys = deviceKeypair();
    const claimToken = await mintToken("Retry frame");

    const first = await enroll(claimToken, keys.publicKeyBase64);
    expect(first.status).toBe(200);
    const firstPayload = (await first.json()) as {
      access_token: string;
      frame_id: string;
    };

    // The device never saw that response and retries the exact same call.
    const retry = await enroll(claimToken, keys.publicKeyBase64);
    expect(retry.status).toBe(200);
    const retryPayload = (await retry.json()) as {
      access_token: string;
      frame_id: string;
      status: string;
    };
    expect(retryPayload.frame_id).toBe(firstPayload.frame_id);
    expect(retryPayload.status).toBe("pending");
    // No orphan frame, no orphan linked client, no extra use spent.
    expect(
      await db.select().from(frames).where(eq(frames.accountId, accountId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(linkedClients)
        .where(eq(linkedClients.accountId, accountId)),
    ).toHaveLength(1);
    expect(await claimTokenUseCount(claimToken)).toBe(1);

    // The token handed back actually works…
    const withRetryToken = await enrollFrame(
      postJson(
        "/api/frames/enroll",
        { public_key: keys.publicKeyBase64 },
        { authorization: `Bearer ${retryPayload.access_token}` },
      ),
    );
    expect(withRetryToken.status).toBe(200);
    expect(
      ((await withRetryToken.json()) as { frame_id: string }).frame_id,
    ).toBe(firstPayload.frame_id);

    // …and pinning still holds: a different key on the same bearer is 409.
    const swap = await enrollFrame(
      postJson(
        "/api/frames/enroll",
        { public_key: deviceKeypair().publicKeyBase64 },
        { authorization: `Bearer ${retryPayload.access_token}` },
      ),
    );
    expect(swap.status).toBe(409);

    // A *different* device replaying a spent single-use token gets nothing.
    const otherDevice = await enroll(
      claimToken,
      deviceKeypair().publicKeyBase64,
    );
    expect(otherDevice.status).toBe(400);
    expect(((await otherDevice.json()) as { error: string }).error).toBe(
      "invalid_claim_token",
    );
  });

  it("refuses flow B without the frame:managed scope", async () => {
    const accountId = await signIn();
    const token = `fc_link_${"b".repeat(40)}`;
    const { hashSecret } = await import("../../lib/secrets");
    await db.insert(linkedClients).values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: ["frame:link"] },
      publicDisplayName: "Unmanaged frame",
      tokenReference: hashSecret(token),
    });
    const response = await enrollFrame(
      postJson(
        "/api/frames/enroll",
        { public_key: deviceKeypair().publicKeyBase64 },
        { authorization: `Bearer ${token}` },
      ),
    );
    expect(response.status).toBe(403);
  });
});

describe("frame management API", () => {
  it("assigns scenes, enqueues set_scenes, and blocks shell-flagged scenes", async () => {
    const { accountId, frame_id } = await enrolledFrame();
    await confirmFrame(
      postJson(`/api/frames/${frame_id}/confirm`, {}, { origin: baseUrl }),
      routeParams(frame_id),
    );
    const scene = await createStoreScene(accountId, { name: "Clock" });

    const assign = await assignFrameScenes(
      postJson(
        `/api/frames/${frame_id}/scenes`,
        { scenes: [{ scene_id: scene.id }] },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(assign.status).toBe(200);
    const assignPayload = (await assign.json()) as Record<string, unknown>;
    expect(assignPayload.status).toBe("queued");
    expect(typeof assignPayload.assigned_checksum).toBe("string");

    const commands = await db
      .select()
      .from(frameCommands)
      .where(eq(frameCommands.frameId, frame_id));
    expect(commands).toHaveLength(1);
    expect(commands[0]?.type).toBe("set_scenes");
    const commandPayload = commands[0]?.payload as {
      checksum: string;
      scenes: unknown[];
    };
    expect(commandPayload.checksum).toBe(assignPayload.assigned_checksum);
    expect(commandPayload.scenes).toHaveLength(1);

    const listed = await getFrameScenes(
      getRequest(`/api/frames/${frame_id}/scenes`),
      routeParams(frame_id),
    );
    expect(listed.status).toBe(200);
    const listedPayload = (await listed.json()) as { scenes: unknown[] };
    expect(listedPayload.scenes).toHaveLength(1);

    // Shell-flagged scenes are refused outright.
    const shellScene = await createStoreScene(accountId, {
      name: "Shell scene",
      riskFlags: ["shell"],
    });
    const refused = await assignFrameScenes(
      postJson(
        `/api/frames/${frame_id}/scenes`,
        { scenes: [{ scene_id: shellScene.id }] },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "scene_not_allowed",
    );

    // Someone else's private scene is invisible.
    const ownerCookie = cookieJar.get(sessionCookieName);
    const otherAccount = await signIn();
    const otherScene = await createStoreScene(otherAccount, {
      name: "Private scene",
    });
    cookieJar.set(sessionCookieName, ownerCookie!);
    const invisible = await assignFrameScenes(
      postJson(
        `/api/frames/${frame_id}/scenes`,
        { scenes: [{ scene_id: otherScene.id }] },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(invisible.status).toBe(400);
  });

  it("gates on the PINNED version's risk flags, not the latest version's", async () => {
    // Publish shell-flagged v1, publish clean v2 (which overwrites
    // store_scenes.risk_flags), then pin v1: the old gate read the scene row
    // and happily pushed shell-flagged bytes.
    const { accountId, frame_id } = await enrolledFrame();
    await confirmFrame(
      postJson(`/api/frames/${frame_id}/confirm`, {}, { origin: baseUrl }),
      routeParams(frame_id),
    );
    const scene = await createStoreScene(accountId, {
      name: "Two faced",
      riskFlags: ["shell"],
    });
    await publishSceneVersion(scene.id, 2, []);

    const [sceneRow] = await db
      .select()
      .from(storeScenes)
      .where(eq(storeScenes.id, scene.id));
    expect(sceneRow?.riskFlags).toEqual([]);

    const pinnedOld = await assignFrameScenes(
      postJson(
        `/api/frames/${frame_id}/scenes`,
        { scenes: [{ scene_id: scene.id, scene_version: 1 }] },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(pinnedOld.status).toBe(403);
    expect(((await pinnedOld.json()) as { error: string }).error).toBe(
      "scene_not_allowed",
    );
    expect(
      await db
        .select()
        .from(frameSceneAssignments)
        .where(eq(frameSceneAssignments.frameId, frame_id)),
    ).toHaveLength(0);

    // The clean version is still pushable, pinned or tracking latest.
    const pinnedNew = await assignFrameScenes(
      postJson(
        `/api/frames/${frame_id}/scenes`,
        { scenes: [{ scene_id: scene.id, scene_version: 2 }] },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(pinnedNew.status).toBe(200);

    const latest = await assignFrameScenes(
      postJson(
        `/api/frames/${frame_id}/scenes`,
        { scenes: [{ scene_id: scene.id }] },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(latest.status).toBe(200);
  });

  it("rolls the assignment back when the pinned version does not exist", async () => {
    const { accountId, frame_id } = await enrolledFrame();
    await confirmFrame(
      postJson(`/api/frames/${frame_id}/confirm`, {}, { origin: baseUrl }),
      routeParams(frame_id),
    );
    const good = await createStoreScene(accountId, { name: "Good" });
    const assigned = await assignFrameScenes(
      postJson(
        `/api/frames/${frame_id}/scenes`,
        { scenes: [{ scene_id: good.id }] },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(assigned.status).toBe(200);
    const { assigned_checksum: originalChecksum } = (await assigned.json()) as {
      assigned_checksum: string;
    };

    const missing = await createStoreScene(accountId, { name: "Missing" });
    const refused = await assignFrameScenes(
      postJson(
        `/api/frames/${frame_id}/scenes`,
        { scenes: [{ scene_id: missing.id, scene_version: 999 }] },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "scene_version_missing",
    );

    // The previous assignment survives untouched and still matches the
    // checksum the device was actually pushed.
    const listed = await getFrameScenes(
      getRequest(`/api/frames/${frame_id}/scenes`),
      routeParams(frame_id),
    );
    const listedPayload = (await listed.json()) as {
      assigned_checksum: string;
      scenes: { scene_id: string }[];
    };
    expect(listedPayload.scenes.map((row) => row.scene_id)).toEqual([good.id]);
    expect(listedPayload.assigned_checksum).toBe(originalChecksum);
    const commands = await db
      .select()
      .from(frameCommands)
      .where(eq(frameCommands.frameId, frame_id));
    expect(commands).toHaveLength(1);
  });

  it("refuses an assembled set_scenes payload larger than the device can take", async () => {
    const { accountId, frame_id } = await enrolledFrame();
    await confirmFrame(
      postJson(`/api/frames/${frame_id}/confirm`, {}, { origin: baseUrl }),
      routeParams(frame_id),
    );
    const scene = await createStoreScene(accountId, { name: "Huge" });
    // Replace the version payload with one whose scenes.json alone blows the
    // cap: the hub pushes this in a single WebSocket frame to a Pi Zero.
    const huge = [
      {
        edges: [],
        id: scene.id,
        name: "Huge",
        nodes: [{ data: { blob: "x".repeat(maxScenesPayloadBytes + 1024) } }],
      },
    ];
    await db
      .update(storeSceneVersions)
      .set({
        content: Buffer.from(
          zipSync({
            "scene/scenes.json": new TextEncoder().encode(
              JSON.stringify(huge),
            ),
          }),
        ),
      })
      .where(eq(storeSceneVersions.sceneId, scene.id));

    const refused = await assignFrameScenes(
      postJson(
        `/api/frames/${frame_id}/scenes`,
        { scenes: [{ scene_id: scene.id }] },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "scenes_payload_too_large",
    );
    // Rolled back: nothing assigned, nothing queued.
    expect(
      await db
        .select()
        .from(frameSceneAssignments)
        .where(eq(frameSceneAssignments.frameId, frame_id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(frameCommands)
        .where(eq(frameCommands.frameId, frame_id)),
    ).toHaveLength(0);
  });

  it("refuses scene pushes while the frame is pending", async () => {
    const { accountId, frame_id } = await enrolledFrame();
    const scene = await createStoreScene(accountId, { name: "Early" });
    const refused = await assignFrameScenes(
      postJson(
        `/api/frames/${frame_id}/scenes`,
        { scenes: [{ scene_id: scene.id }] },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(refused.status).toBe(409);
  });

  it("enforces the settings allowlist and command types", async () => {
    const { frame_id } = await enrolledFrame();
    await confirmFrame(
      postJson(`/api/frames/${frame_id}/confirm`, {}, { origin: baseUrl }),
      routeParams(frame_id),
    );

    const ok = await pushFrameSettings(
      postJson(
        `/api/frames/${frame_id}/settings`,
        { settings: { interval: 300, rotate: 90 } },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(ok.status).toBe(200);

    const badKey = await pushFrameSettings(
      postJson(
        `/api/frames/${frame_id}/settings`,
        { settings: { rotate: 90, ssh_user: "root" } },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(badKey.status).toBe(400);
    expect(((await badKey.json()) as { error: string }).error).toBe(
      "setting_not_allowed",
    );

    const render = await sendCommand(
      postJson(
        `/api/frames/${frame_id}/command`,
        { type: "render" },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(render.status).toBe(200);

    const shell = await sendCommand(
      postJson(
        `/api/frames/${frame_id}/command`,
        { cmd: "rm -rf /", type: "shell" },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(shell.status).toBe(400);
    expect(((await shell.json()) as { error: string }).error).toBe(
      "invalid_command",
    );
  });

  it("accepts exactly the device's settings allowlist, in the device's spelling", async () => {
    // Authoritative list: CLOUD_SETTINGS_ALLOWLIST in
    // frameos/src/frameos/cloud/hub_client.nim, mirrored in
    // docs/cloud-frames.md. The hub forwards keys verbatim and the device
    // refuses the whole verb on one unknown key, so this must match exactly.
    expect([...allowedFrameSettings.keys()].sort()).toEqual(
      ["debug", "interval", "name", "rotate", "scaling_mode", "timezone"].sort(),
    );

    const { frame_id } = await enrolledFrame();
    await confirmFrame(
      postJson(`/api/frames/${frame_id}/confirm`, {}, { origin: baseUrl }),
      routeParams(frame_id),
    );

    const push = (settings: Record<string, unknown>) =>
      pushFrameSettings(
        postJson(
          `/api/frames/${frame_id}/settings`,
          { settings },
          { origin: baseUrl },
        ),
        routeParams(frame_id),
      );

    const snake = await push({ scaling_mode: "cover" });
    expect(snake.status).toBe(200);

    // The camelCase spelling the device has never heard of is refused here
    // rather than silently voiding the whole push on the device.
    const camel = await push({ scalingMode: "cover" });
    expect(camel.status).toBe(400);
    expect(((await camel.json()) as { error: string }).error).toBe(
      "setting_not_allowed",
    );

    // brightness is deferred until the runtime grows the setting.
    const brightness = await push({ brightness: 50 });
    expect(brightness.status).toBe(400);
  });

  // The frame's name is provider-side data (frames.name, what frameSummary
  // returns) — the device never has to accept it. The ESP32 firmware answers
  // `unsupported_verb` for set_settings, so the route applies `name` directly
  // to the row and skips the enqueue for esp32 platforms; anything else in
  // the payload is refused up front so nothing is half-applied.
  it("renames an esp32 frame in the DB without enqueueing set_settings", async () => {
    const accountId = await signIn();
    const keys = deviceKeypair();
    const claimToken = await mintToken("Desk esp32");
    const enrolled = await enroll(claimToken, keys.publicKeyBase64, {
      hardware: { height: 480, platform: "esp32", width: 800 },
    });
    expect(enrolled.status).toBe(200);
    const { frame_id } = (await enrolled.json()) as { frame_id: string };
    await confirmFrame(
      postJson(`/api/frames/${frame_id}/confirm`, {}, { origin: baseUrl }),
      routeParams(frame_id),
    );

    const renamed = await pushFrameSettings(
      postJson(
        `/api/frames/${frame_id}/settings`,
        { settings: { name: "Hallway epaper" } },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { status: string }).status).toBe(
      "applied",
    );

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame_id));
    expect(frame?.accountId).toBe(accountId);
    expect(frame?.name).toBe("Hallway epaper");

    const commands = await db
      .select()
      .from(frameCommands)
      .where(eq(frameCommands.frameId, frame_id));
    expect(commands.filter((c) => c.type === "set_settings")).toHaveLength(0);
  });

  it("refuses a mixed esp32 settings payload without applying the name", async () => {
    const keys = deviceKeypair();
    await signIn();
    const claimToken = await mintToken("Desk esp32");
    const enrolled = await enroll(claimToken, keys.publicKeyBase64, {
      hardware: { height: 480, platform: "ESP32-S3", width: 800 },
    });
    expect(enrolled.status).toBe(200);
    const { frame_id } = (await enrolled.json()) as { frame_id: string };
    await confirmFrame(
      postJson(`/api/frames/${frame_id}/confirm`, {}, { origin: baseUrl }),
      routeParams(frame_id),
    );
    const [before] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame_id));

    const refused = await pushFrameSettings(
      postJson(
        `/api/frames/${frame_id}/settings`,
        { settings: { name: "Half-applied", rotate: 90 } },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "settings_not_supported_by_device",
    );

    // Nothing was applied: not the name, and no command either.
    const [after] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame_id));
    expect(after?.name).toBe(before?.name);
    const commands = await db
      .select()
      .from(frameCommands)
      .where(eq(frameCommands.frameId, frame_id));
    expect(commands).toHaveLength(0);
  });

  it("renames a non-esp32 frame in the DB AND pushes set_settings to the device", async () => {
    // enrolledFrame() enrolls with platform "pi-zero2w".
    const { frame_id } = await enrolledFrame();
    await confirmFrame(
      postJson(`/api/frames/${frame_id}/confirm`, {}, { origin: baseUrl }),
      routeParams(frame_id),
    );

    const renamed = await pushFrameSettings(
      postJson(
        `/api/frames/${frame_id}/settings`,
        { settings: { name: "Kitchen, renamed" } },
        { origin: baseUrl },
      ),
      routeParams(frame_id),
    );
    expect(renamed.status).toBe(200);
    const payload = (await renamed.json()) as {
      command_id: string | null;
      status: string;
    };
    expect(payload.status).toBe("queued");
    expect(payload.command_id).toBeTruthy();

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame_id));
    expect(frame?.name).toBe("Kitchen, renamed");

    // The device's local config stays in sync: the push carries the name.
    const commands = await db
      .select()
      .from(frameCommands)
      .where(eq(frameCommands.frameId, frame_id));
    const setSettings = commands.filter((c) => c.type === "set_settings");
    expect(setSettings).toHaveLength(1);
    expect(setSettings[0]!.payload).toEqual({
      settings: { name: "Kitchen, renamed" },
    });
  });

  it("refuses JS prototype keys cleanly instead of crashing or passing them", async () => {
    const { frame_id } = await enrolledFrame();
    await confirmFrame(
      postJson(`/api/frames/${frame_id}/confirm`, {}, { origin: baseUrl }),
      routeParams(frame_id),
    );

    // "toString" resolves through Object.prototype to a truthy callable that
    // returns a truthy string; "__proto__"/"valueOf"/"hasOwnProperty" resolve
    // to values that make the check throw. Both must be plain 4xx refusals.
    for (const key of [
      "toString",
      "constructor",
      "__proto__",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
    ]) {
      const response = await pushFrameSettings(
        postJson(
          `/api/frames/${frame_id}/settings`,
          { settings: { [key]: 1 } },
          { origin: baseUrl },
        ),
        routeParams(frame_id),
      );
      expect([key, response.status]).toEqual([key, 400]);
      expect([key, ((await response.json()) as { error: string }).error]).toEqual(
        [key, "setting_not_allowed"],
      );
    }

    // Nothing was enqueued by any of them.
    const commands = await db
      .select()
      .from(frameCommands)
      .where(eq(frameCommands.frameId, frame_id));
    expect(commands).toHaveLength(0);
  });

  it("answers 404, not 500, for frame ids that are not uuids", async () => {
    await signIn();
    const bogus = "not-a-uuid";
    const responses = await Promise.all([
      getFrameDetail(getRequest(`/api/frames/${bogus}`), routeParams(bogus)),
      getFrameLogs(
        getRequest(`/api/frames/${bogus}/logs`),
        routeParams(bogus),
      ),
      getFrameScenes(
        getRequest(`/api/frames/${bogus}/scenes`),
        routeParams(bogus),
      ),
      confirmFrame(
        postJson(`/api/frames/${bogus}/confirm`, {}, { origin: baseUrl }),
        routeParams(bogus),
      ),
      revokeFrameRoute(
        postJson(`/api/frames/${bogus}/revoke`, {}, { origin: baseUrl }),
        routeParams(bogus),
      ),
      sendCommand(
        postJson(
          `/api/frames/${bogus}/command`,
          { type: "render" },
          { origin: baseUrl },
        ),
        routeParams(bogus),
      ),
      pushFrameSettings(
        postJson(
          `/api/frames/${bogus}/settings`,
          { settings: { rotate: 90 } },
          { origin: baseUrl },
        ),
        routeParams(bogus),
      ),
      assignFrameScenes(
        postJson(
          `/api/frames/${bogus}/scenes`,
          { scenes: [] },
          { origin: baseUrl },
        ),
        routeParams(bogus),
      ),
    ]);
    expect(responses.map((response) => response.status)).toEqual(
      responses.map(() => 404),
    );
  });

  it("serves retained logs incrementally and lists frames", async () => {
    const { frame_id } = await enrolledFrame();
    await db.insert(frameLogs).values(
      Array.from({ length: 3 }, (_, index) => ({
        frameId: frame_id,
        payload: { event: "render", line: `line ${index}` },
        sizeBytes: 40,
        timestamp: new Date(),
      })),
    );

    const all = await getFrameLogs(
      getRequest(`/api/frames/${frame_id}/logs`),
      routeParams(frame_id),
    );
    expect(all.status).toBe(200);
    const allPayload = (await all.json()) as {
      has_more: boolean;
      logs: { id: number; line: string; type: string }[];
    };
    expect(allPayload.logs).toHaveLength(3);
    expect(allPayload.logs[0]?.type).toBe("render");
    expect(allPayload.has_more).toBe(false);

    const after = await getFrameLogs(
      getRequest(
        `/api/frames/${frame_id}/logs?after_id=${allPayload.logs[1]!.id}`,
      ),
      routeParams(frame_id),
    );
    const afterPayload = (await after.json()) as { logs: unknown[] };
    expect(afterPayload.logs).toHaveLength(1);

    // after_id=0 is a cursor meaning "from the beginning", not an absent one.
    const fromZero = await getFrameLogs(
      getRequest(`/api/frames/${frame_id}/logs?after_id=0`),
      routeParams(frame_id),
    );
    const fromZeroPayload = (await fromZero.json()) as { logs: unknown[] };
    expect(fromZeroPayload.logs).toHaveLength(3);

    const list = await listFrames(getRequest("/api/frames"));
    expect(list.status).toBe(200);
    const listPayload = (await list.json()) as { frames: unknown[] };
    expect(listPayload.frames).toHaveLength(1);
  });

  it("opens the log page on the NEWEST rows when the window overflows a page", async () => {
    // Without a cursor the panel shows the first page it gets — ascending
    // from a 5000-row retention window that used to be the oldest, stalest
    // logs. It must mirror the backend: newest page, chronological order.
    const { frame_id } = await enrolledFrame();
    const total = 1001; // maxLogsPerPage + 1
    const batch = 250;
    for (let offset = 0; offset < total; offset += batch) {
      await db.insert(frameLogs).values(
        Array.from({ length: Math.min(batch, total - offset) }, (_, index) => ({
          frameId: frame_id,
          payload: { event: "log", line: `line ${offset + index}` },
          sizeBytes: 40,
          timestamp: new Date(),
        })),
      );
    }

    const response = await getFrameLogs(
      getRequest(`/api/frames/${frame_id}/logs`),
      routeParams(frame_id),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      has_more: boolean;
      logs: { id: number; line: string }[];
    };
    expect(payload.logs).toHaveLength(1000);
    expect(payload.has_more).toBe(true);
    // The oldest row fell off the page; the newest is last (chronological).
    expect(payload.logs[0]?.line).toBe("line 1");
    expect(payload.logs.at(-1)?.line).toBe("line 1000");
    // Ids ascend within the page, so ?after_id incremental catch-up works.
    expect(payload.logs[0]!.id).toBeLessThan(payload.logs.at(-1)!.id);
  });

  it("downloads the full retained log as text", async () => {
    const { frame_id } = await enrolledFrame();
    await db.insert(frameLogs).values(
      Array.from({ length: 2 }, (_, index) => ({
        frameId: frame_id,
        payload: { event: "render", line: `full line ${index}` },
        sizeBytes: 40,
        timestamp: new Date("2026-08-01T00:00:00Z"),
      })),
    );

    const response = await getFrameLogsFull(
      getRequest(`/api/frames/${frame_id}/logs/full`),
      routeParams(frame_id),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-disposition")).toContain("full-logs");
    const body = await response.text();
    expect(body).toBe(
      "[2026-08-01T00:00:00.000Z] (render) full line 0\n" +
        "[2026-08-01T00:00:00.000Z] (render) full line 1\n",
    );
  });

  it("revokes a frame: linked client dies, queue drains, bearer stops working", async () => {
    const { access_token, frame_id } = await enrolledFrame();
    const revoke = await revokeFrameRoute(
      postJson(`/api/frames/${frame_id}/revoke`, {}, { origin: baseUrl }),
      routeParams(frame_id),
    );
    expect(revoke.status).toBe(200);

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame_id));
    expect(frame?.status).toBe("revoked");
    const [client] = await db
      .select()
      .from(linkedClients)
      .where(eq(linkedClients.id, frame!.linkedClientId));
    expect(client?.revokedAt).not.toBeNull();

    // The device's bearer token is dead (flow-B style re-registration 401s).
    const dead = await enrollFrame(
      postJson(
        "/api/frames/enroll",
        { public_key: deviceKeypair().publicKeyBase64 },
        { authorization: `Bearer ${access_token}` },
      ),
    );
    expect(dead.status).toBe(401);
  });

  it("requires a session and an app origin for mutations", async () => {
    const { frame_id } = await enrolledFrame();
    // CSRF: wrong origin refused.
    const badOrigin = await sendCommand(
      postJson(
        `/api/frames/${frame_id}/command`,
        { type: "render" },
        { origin: "https://evil.example" },
      ),
      routeParams(frame_id),
    );
    expect(badOrigin.status).toBe(403);

    // No session: 401.
    cookieJar.clear();
    const noSession = await listFrames(getRequest("/api/frames"));
    expect(noSession.status).toBe(401);
  });

  it("cross-account access is invisible, not forbidden", async () => {
    const { frame_id } = await enrolledFrame();
    await signIn(); // a different account
    const detail = await getFrameLogs(
      getRequest(`/api/frames/${frame_id}/logs`),
      routeParams(frame_id),
    );
    expect(detail.status).toBe(404);
  });
});
