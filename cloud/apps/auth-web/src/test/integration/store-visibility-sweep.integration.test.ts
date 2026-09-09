import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import { NextRequest } from "next/server";
import {
  createDb,
  frameSceneAssignments,
  frames,
  linkedClients,
  storeImages,
  storeSceneVersionImages,
  storeSceneVersions,
  storeScenes,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH as patchScene } from "../../../app/api/account/scenes/[sceneId]/route";
import { buildScenesPayloadForFrame } from "../../lib/frames";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { hashSecret } from "../../lib/secrets";
import { createSession, sessionCookieName } from "../../lib/session";

// Two §2 review gaps, pinned:
//
//   * a scene flipped PRIVATE stops streaming its versions to a stranger's
//     frame that installed it while it was public — decided on the path that
//     produces the bytes (buildScenesPayloadForFrame), which the assignment
//     re-push and the hub's resync both go through;
//   * an image upload that no version ever bound is reclaimed by the
//     object-store sweep after a week, and a bound or referenced one is not.
//     The sweep's SQL lives in cloud/scripts/object-store-sweep.sh; the test
//     runs THAT text, so the script cannot drift away from what is pinned.

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

async function signIn() {
  userCounter += 1;
  const providerSubject = `visibility-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Visibility User ${userCounter}`,
    email: `visibility-${userCounter}@example.com`,
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

function sceneZip(sceneId: string, version: number) {
  const scenes = [
    {
      edges: [],
      fields: [],
      id: sceneId,
      name: `Scene ${sceneId} v${version}`,
      nodes: [],
      settings: { execution: "interpreted" },
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

async function createPublicScene(accountId: string, name: string) {
  const [scene] = await db
    .insert(storeScenes)
    .values({
      accountId,
      latestVersion: 1,
      name,
      riskFlags: [],
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      status: "active",
      visibility: "public",
    })
    .returning();
  if (!scene) {
    throw new Error("scene insert failed");
  }
  await addVersion(scene.id, 1);
  return scene;
}

async function addVersion(sceneId: string, version: number) {
  const [row] = await db
    .insert(storeSceneVersions)
    .values({
      content: sceneZip(sceneId, version),
      contentType: "application/zip",
      riskFlags: [],
      sceneId,
      sha256: `test-${sceneId}-v${version}`,
      sizeBytes: 1000,
      version,
    })
    .returning({ id: storeSceneVersions.id });
  await db
    .update(storeScenes)
    .set({ latestVersion: version })
    .where(eq(storeScenes.id, sceneId));
  return row!.id;
}

// A frame row without the enrollment round trip: the payload builder only
// reads frames.account_id.
async function seedFrame(accountId: string, name: string) {
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      providerClientMetadata: { requestedScopes: ["frame:managed"] },
      publicDisplayName: name,
      tokenReference: hashSecret(`fc_link_seed_${accountId}_${name}`),
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      linkedClientId: client!.id,
      name,
      publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      status: "active",
    })
    .returning({ id: frames.id });
  return frame!.id;
}

async function assign(frameId: string, sceneId: string) {
  await db.insert(frameSceneAssignments).values({ frameId, position: 0, sceneId });
}

// The version each assigned store scene resolved to, or the refusal.
function payloadVersions(
  payload: Awaited<ReturnType<typeof buildScenesPayloadForFrame>>,
) {
  return "error" in payload
    ? payload.error
    : Object.fromEntries(
        Object.entries(payload.sceneStates).map(([id, state]) => [id, state.version]),
      );
}

describe("a private flip and the frames that installed the scene", () => {
  it("keeps the owner's frame on new versions and cuts a stranger's frame off", async () => {
    const strangerId = await signIn();
    const strangerFrame = await seedFrame(strangerId, "Stranger frame");
    const ownerId = await signIn();
    const ownerFrame = await seedFrame(ownerId, "Owner frame");

    const scene = await createPublicScene(ownerId, "Public Clock");
    await assign(strangerFrame, scene.id);
    await assign(ownerFrame, scene.id);

    // Public: both frames get version 1.
    expect(payloadVersions(await buildScenesPayloadForFrame(db, strangerFrame))).toEqual({
      [scene.id]: 1,
    });
    expect(payloadVersions(await buildScenesPayloadForFrame(db, ownerFrame))).toEqual({
      [scene.id]: 1,
    });

    // The owner (signed in last, so the cookie jar holds their session)
    // flips the scene private through the real route.
    const flipped = await patchScene(
      new NextRequest(new URL(`/api/account/scenes/${scene.id}`, baseUrl), {
        body: JSON.stringify({ visibility: "private" }),
        headers: { "content-type": "application/json", origin: baseUrl },
        method: "PATCH",
      }),
      { params: Promise.resolve({ sceneId: scene.id }) },
    );
    expect(flipped.status).toBe(200);
    await addVersion(scene.id, 2);

    // The owner's frame follows the scene to version 2 …
    expect(payloadVersions(await buildScenesPayloadForFrame(db, ownerFrame))).toEqual({
      [scene.id]: 2,
    });
    // … the stranger's frame gets nothing new, not even version 1 again.
    expect(await buildScenesPayloadForFrame(db, strangerFrame)).toEqual({
      error: "scene_private",
    });
  });
});

describe("the object-store sweep reclaims unbound image uploads", () => {
  // The exact statement the script runs, lifted from its source.
  function sweepUnboundSql() {
    const script = readFileSync(
      path.resolve(__dirname, "..", "..", "..", "..", "..", "scripts", "object-store-sweep.sh"),
      "utf8",
    );
    const match = /unbound_sql="\n([\s\S]*?)"\n/.exec(script);
    if (!match?.[1]) {
      throw new Error("object-store-sweep.sh no longer defines unbound_sql");
    }
    return match[1];
  }

  async function image(sha: string, ageDays: number, accountId: string) {
    await db.insert(storeImages).values({
      accountId,
      contentType: "image/png",
      createdAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000),
      objectKey: `store/scene-images/${sha}`,
      sha256: sha,
      sizeBytes: 100,
    });
  }

  it("deletes week-old uploads no version bound, and nothing else", async () => {
    const ownerId = await signIn();
    const scene = await createPublicScene(ownerId, "Gallery Scene");
    const [versionRow] = await db
      .select({ id: storeSceneVersions.id })
      .from(storeSceneVersions)
      .where(eq(storeSceneVersions.sceneId, scene.id));

    const oldUnbound = "a".repeat(64);
    const freshUnbound = "b".repeat(64);
    const oldBound = "c".repeat(64);
    const oldPreview = "d".repeat(64);
    await image(oldUnbound, 8, ownerId);
    await image(freshUnbound, 1, ownerId);
    await image(oldBound, 30, ownerId);
    await image(oldPreview, 30, ownerId);
    await db.insert(storeSceneVersionImages).values({
      imageSha256: oldBound,
      position: 0,
      versionId: versionRow!.id,
    });
    await db
      .update(storeScenes)
      .set({ previewObjectKey: `store/scene-images/${oldPreview}` })
      .where(eq(storeScenes.id, scene.id));

    await db.execute(sql.raw(sweepUnboundSql()));

    const remaining = (await db.select({ sha256: storeImages.sha256 }).from(storeImages))
      .map((row) => row.sha256)
      .sort();
    expect(remaining).toEqual([freshUnbound, oldBound, oldPreview].sort());
  });
});
