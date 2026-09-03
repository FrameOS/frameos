// Service-settings delivery to a cloud-managed frame, end to end
// (docs/cloud-frames.md "Service settings"): enroll a real frame, assign a
// scene that declares Unsplash, save the account's key, and pull it as the
// device with its enrollment bearer. Then revoke the owner's switch and watch
// the same pull turn into a 403.
//
// The queue-hygiene assertions at the bottom are the point of the whole
// design: `frame_commands` rows are never deleted, so a key that ever entered
// the queue would outlive the account setting that spawned it. Nothing in
// this suite may ever put one there.
import { generateKeyPairSync } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import { NextRequest } from "next/server";
import {
  createDb,
  frameCommands,
  frameSceneAssignments,
  frames,
  linkedClients,
  storeScenes,
  storeSceneVersions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as mintClaimToken } from "../../../app/api/frames/claim-tokens/route";
import { POST as enrollFrame } from "../../../app/api/frames/enroll/route";
import { POST as confirmFrame } from "../../../app/api/frames/[frameId]/confirm/route";
import { POST as addFrameScene } from "../../../app/api/frames/[frameId]/scenes/add/route";
import { POST as activateScene } from "../../../app/api/frames/[frameId]/event/[eventName]/route";
import {
  GET as listFrameScenes,
  POST as assignFrameScenes,
} from "../../../app/api/frames/[frameId]/scenes/route";
import { GET as pullServiceSettings } from "../../../app/api/frames/[frameId]/service-settings/route";
import { POST as setServiceSettingsEnabled } from "../../../app/api/frames/[frameId]/service-settings/enabled/route";
import { POST as saveAccountSettings } from "../../../app/api/settings/route";
import { linkedClientScopes } from "../../lib/backend-auth";
import { frameServiceSettingsScope } from "../../lib/frames";
import { resetRateLimitForTests } from "../../lib/rate-limit";
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

const unsplashKey = "unsplash-access-key-do-not-queue";
const openAiKey = "openai-api-key-do-not-queue";

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
  const providerSubject = `service-settings-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Service Settings User ${userCounter}`,
    email: `service-settings-${userCounter}@example.com`,
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

function devicePublicKey() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

// A scene whose only app node is `data/unsplash` — the keyword table in
// src/lib/preview-settings.ts maps it to the `unsplash` settings group.
function sceneZip(sceneId: string, keyword: string) {
  return sceneZipWithKeywords(sceneId, [keyword]);
}

function sceneZipWithKeywords(sceneId: string, keywords: string[]) {
  const scenes = [
    {
      edges: [],
      id: sceneId,
      name: `Scene ${sceneId}`,
      nodes: keywords.map((keyword, index) => ({
        data: { keyword },
        id: `node-${index + 1}`,
        type: "app",
      })),
    },
  ];
  return Buffer.from(
    zipSync({
      "scene/scenes.json": new TextEncoder().encode(JSON.stringify(scenes)),
    }),
  );
}

async function createStoreScene(accountId: string, keyword: string) {
  const [scene] = await db
    .insert(storeScenes)
    .values({
      accountId,
      latestVersion: 1,
      name: `Scene using ${keyword}`,
      riskFlags: [],
      slug: `scene-${keyword.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      status: "active",
      visibility: "private",
    })
    .returning();
  if (!scene) {
    throw new Error("scene insert failed");
  }
  await db.insert(storeSceneVersions).values({
    content: sceneZip(scene.id, keyword),
    contentType: "application/zip",
    riskFlags: [],
    sceneId: scene.id,
    sha256: "test",
    sizeBytes: 1000,
    version: 1,
  });
  return scene;
}

// Enroll → confirm → active, the claim-token path a real frame walks.
async function activeFrame() {
  const accountId = await signIn();
  const mintResponse = await mintClaimToken(
    postJson(
      "/api/frames/claim-tokens",
      { name: "Service settings frame" },
      { origin: baseUrl },
    ),
  );
  expect(mintResponse.status).toBe(200);
  const { claim_token } = (await mintResponse.json()) as { claim_token: string };
  const response = await enrollFrame(
    postJson("/api/frames/enroll", {
      claim_token,
      frameos_version: "2026.8.1",
      hardware: { height: 480, platform: "pi-zero2w", width: 800 },
      public_key: devicePublicKey(),
    }),
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    access_token: string;
    frame_id: string;
    scope: string;
  };
  const confirm = await confirmFrame(
    postJson(`/api/frames/${payload.frame_id}/confirm`, {}, { origin: baseUrl }),
    routeParams(payload.frame_id),
  );
  expect(confirm.status).toBe(200);
  return { accountId, ...payload };
}

// Assign one scene, GRANTING it the named groups (the workspace posts a
// scene's declared groups checked at install time). Pass `null` to post no
// settings_groups at all — the "nothing granted" / "keep as is" case.
async function assignScene(
  frameId: string,
  sceneId: string,
  settingsGroups: string[] | null = ["unsplash", "openAI"],
) {
  const response = await assignFrameScenes(
    postJson(
      `/api/frames/${frameId}/scenes`,
      {
        scenes: [
          {
            scene_id: sceneId,
            ...(settingsGroups ? { settings_groups: settingsGroups } : {}),
          },
        ],
      },
      { origin: baseUrl },
    ),
    routeParams(frameId),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    granted_settings_groups: Record<string, string[]>;
  };
}

async function saveSettings(settings: Record<string, unknown>) {
  const response = await saveAccountSettings(
    postJson("/api/settings", settings, { origin: baseUrl }),
  );
  expect(response.status).toBe(200);
}

function pull(frameId: string, accessToken: string, headers: Record<string, string> = {}) {
  return pullServiceSettings(
    getRequest(`/api/frames/${frameId}/service-settings`, {
      authorization: `Bearer ${accessToken}`,
      ...headers,
    }),
    routeParams(frameId),
  );
}

describe("service-settings delivery to a cloud-managed frame", () => {
  it("delivers only the declared group's key, over a device-authed pull", async () => {
    const frame = await activeFrame();
    // A claim-token enrollment grants the scope up front.
    expect(frame.scope.split(" ")).toContain(frameServiceSettingsScope);

    const scene = await createStoreScene(frame.accountId, "data/unsplash");
    await assignScene(frame.frame_id, scene.id);
    // Assignment denormalized the declared groups onto the frame row, so the
    // pull never has to unzip a scene.
    const [row] = await db
      .select({ groups: frames.serviceSettingGroups })
      .from(frames)
      .where(eq(frames.id, frame.frame_id));
    expect(row?.groups).toEqual(["unsplash"]);

    await saveSettings({
      openAI: { apiKey: openAiKey },
      unsplash: { accessKey: unsplashKey },
    });

    const response = await pull(frame.frame_id, frame.access_token);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    // openAI is stored on the account but not declared by this frame's
    // scenes: it never leaves the cloud.
    await expect(response.json()).resolves.toEqual({
      groups: ["unsplash"],
      settings: { unsplash: { accessKey: unsplashKey } },
    });
  });

  it("serves nothing for a scene the owner did not grant, even though it declares a group", async () => {
    const frame = await activeFrame();
    const scene = await createStoreScene(frame.accountId, "data/unsplash");
    await saveSettings({ unsplash: { accessKey: unsplashKey } });

    // No settings_groups on the install: the scene's own declaration is a
    // request, not a grant.
    const assigned = await assignScene(frame.frame_id, scene.id, null);
    expect(assigned.granted_settings_groups).toEqual({ [scene.id]: [] });
    const [row] = await db
      .select()
      .from(frameSceneAssignments)
      .where(eq(frameSceneAssignments.frameId, frame.frame_id));
    expect(row?.declaredSettingsGroups).toEqual(["unsplash"]);
    expect(row?.grantedSettingsGroups).toEqual([]);

    const response = await pull(frame.frame_id, frame.access_token);
    expect(response.status).toBe(200);
    // Not even the group NAME leaks: the device would otherwise treat it as
    // cloud-owned and the UI would say "needs an Unsplash key".
    await expect(response.json()).resolves.toEqual({ groups: [], settings: {} });

    // The scene list tells the owner what the scene asked for vs got.
    const listed = await listFrameScenes(
      getRequest(`/api/frames/${frame.frame_id}/scenes`),
      routeParams(frame.frame_id),
    );
    const { scenes } = (await listed.json()) as {
      scenes: { declared_settings_groups: string[]; granted_settings_groups: string[] }[];
    };
    expect(scenes[0]?.declared_settings_groups).toEqual(["unsplash"]);
    expect(scenes[0]?.granted_settings_groups).toEqual([]);

    // Granting it on a later save — the same POST with the list — serves it.
    await assignScene(frame.frame_id, scene.id, ["unsplash"]);
    await expect((await pull(frame.frame_id, frame.access_token)).json()).resolves.toEqual({
      groups: ["unsplash"],
      settings: { unsplash: { accessKey: unsplashKey } },
    });

    // A grant can never outrun the declaration: openAI is not asked for.
    const widened = await assignScene(frame.frame_id, scene.id, ["unsplash", "openAI"]);
    expect(widened.granted_settings_groups).toEqual({ [scene.id]: ["unsplash"] });
  });

  it("keeps a grant on a save that omits settings_groups and revokes it on an explicit empty list", async () => {
    const frame = await activeFrame();
    const scene = await createStoreScene(frame.accountId, "data/unsplash");
    await saveSettings({ unsplash: { accessKey: unsplashKey } });
    await assignScene(frame.frame_id, scene.id, ["unsplash"]);

    // Reordering, adding a scene: callers that do not touch the grant must
    // not lose it.
    const kept = await assignScene(frame.frame_id, scene.id, null);
    expect(kept.granted_settings_groups).toEqual({ [scene.id]: ["unsplash"] });
    expect((await (await pull(frame.frame_id, frame.access_token)).json()).groups).toEqual(["unsplash"]);

    const revoked = await assignScene(frame.frame_id, scene.id, []);
    expect(revoked.granted_settings_groups).toEqual({ [scene.id]: [] });
    await expect((await pull(frame.frame_id, frame.access_token)).json()).resolves.toEqual({
      groups: [],
      settings: {},
    });
  });

  it("serves a pre-grant assignment everything it declares until the owner saves a list", async () => {
    const frame = await activeFrame();
    const scene = await createStoreScene(frame.accountId, "data/unsplash");
    await saveSettings({ unsplash: { accessKey: unsplashKey } });
    await assignScene(frame.frame_id, scene.id, ["unsplash"]);
    // Simulate a row from before migration 0048: no grant recorded, no
    // declaration computed, and the frame column never computed either.
    await db
      .update(frameSceneAssignments)
      .set({ declaredSettingsGroups: null, grantedSettingsGroups: null })
      .where(eq(frameSceneAssignments.frameId, frame.frame_id));
    await db
      .update(frames)
      .set({ serviceSettingGroups: null })
      .where(eq(frames.id, frame.frame_id));

    // The backfill computes the declaration and reads the NULL grant as
    // "all of it" — no frame that renders today goes dark overnight.
    await expect((await pull(frame.frame_id, frame.access_token)).json()).resolves.toEqual({
      groups: ["unsplash"],
      settings: { unsplash: { accessKey: unsplashKey } },
    });
    const [row] = await db
      .select()
      .from(frameSceneAssignments)
      .where(eq(frameSceneAssignments.frameId, frame.frame_id));
    expect(row?.declaredSettingsGroups).toEqual(["unsplash"]);
    expect(row?.grantedSettingsGroups).toBeNull();

    // The list reports the legacy row as granted = declared, and a save
    // that leaves the grant alone keeps it NULL (still served)...
    const listed = await listFrameScenes(
      getRequest(`/api/frames/${frame.frame_id}/scenes`),
      routeParams(frame.frame_id),
    );
    const { scenes } = (await listed.json()) as {
      scenes: { granted_settings_groups: string[] }[];
    };
    expect(scenes[0]?.granted_settings_groups).toEqual(["unsplash"]);
    await assignScene(frame.frame_id, scene.id, null);
    const [untouched] = await db
      .select()
      .from(frameSceneAssignments)
      .where(eq(frameSceneAssignments.frameId, frame.frame_id));
    expect(untouched?.grantedSettingsGroups).toBeNull();
    expect((await (await pull(frame.frame_id, frame.access_token)).json()).groups).toEqual(["unsplash"]);

    // ...while a save that posts the list makes it explicit.
    await assignScene(frame.frame_id, scene.id, ["unsplash"]);
    const [explicit] = await db
      .select()
      .from(frameSceneAssignments)
      .where(eq(frameSceneAssignments.frameId, frame.frame_id));
    expect(explicit?.grantedSettingsGroups).toEqual(["unsplash"]);
  });

  it("does not widen a grant when an unpinned assignment moves to a version that declares more", async () => {
    const frame = await activeFrame();
    const scene = await createStoreScene(frame.accountId, "data/unsplash");
    await saveSettings({
      openAI: { apiKey: openAiKey },
      unsplash: { accessKey: unsplashKey },
    });
    await assignScene(frame.frame_id, scene.id, ["unsplash"]);

    // v2 adds an OpenAI app. The assignment tracks the latest version.
    await db.insert(storeSceneVersions).values({
      content: sceneZipWithKeywords(scene.id, ["data/unsplash", "data/openaiImage"]),
      contentType: "application/zip",
      riskFlags: [],
      sceneId: scene.id,
      sha256: "test-v2",
      sizeBytes: 1000,
      version: 2,
    });
    await db
      .update(storeScenes)
      .set({ latestVersion: 2 })
      .where(eq(storeScenes.id, scene.id));

    // Activating re-pushes the current assignments at their resolved
    // versions (redeployAssignedScenesToFrame) and refreshes what they
    // declare — but the owner never granted openAI.
    const activate = await activateScene(
      postJson(
        `/api/frames/${frame.frame_id}/event/setCurrentScene`,
        { sceneId: scene.id },
        { origin: baseUrl },
      ),
      { params: Promise.resolve({ eventName: "setCurrentScene", frameId: frame.frame_id }) },
    );
    expect(activate.status).toBe(200);
    const [row] = await db
      .select()
      .from(frameSceneAssignments)
      .where(eq(frameSceneAssignments.frameId, frame.frame_id));
    expect(row?.declaredSettingsGroups).toEqual(["openAI", "unsplash"]);
    expect(row?.grantedSettingsGroups).toEqual(["unsplash"]);
    await expect((await pull(frame.frame_id, frame.access_token)).json()).resolves.toEqual({
      groups: ["unsplash"],
      settings: { unsplash: { accessKey: unsplashKey } },
    });
  });

  it("reports what a store install asked for and got, so the owner can be told what it still needs", async () => {
    const frame = await activeFrame();
    const scene = await createStoreScene(frame.accountId, "data/unsplash");
    const installed = await addFrameScene(
      postJson(
        `/api/frames/${frame.frame_id}/scenes/add`,
        { scene_id: scene.id },
        { origin: baseUrl },
      ),
      routeParams(frame.frame_id),
    );
    expect(installed.status).toBe(200);
    await expect(installed.json()).resolves.toMatchObject({
      declared_settings_groups: ["unsplash"],
      granted_settings_groups: [],
    });
    // Re-installing with a grant (the store page's ticked checkbox) grants;
    // a malformed list is refused rather than dropped.
    const granted = await addFrameScene(
      postJson(
        `/api/frames/${frame.frame_id}/scenes/add`,
        { scene_id: scene.id, settings_groups: ["unsplash"] },
        { origin: baseUrl },
      ),
      routeParams(frame.frame_id),
    );
    await expect(granted.json()).resolves.toMatchObject({
      already_assigned: true,
      granted_settings_groups: ["unsplash"],
    });
    const malformed = await addFrameScene(
      postJson(
        `/api/frames/${frame.frame_id}/scenes/add`,
        { scene_id: scene.id, settings_groups: "unsplash" },
        { origin: baseUrl },
      ),
      routeParams(frame.frame_id),
    );
    expect(malformed.status).toBe(400);
  });

  it("answers 304 to a matching If-None-Match and 200 once the key rotates", async () => {
    const frame = await activeFrame();
    const scene = await createStoreScene(frame.accountId, "data/unsplash");
    await assignScene(frame.frame_id, scene.id);
    await saveSettings({ unsplash: { accessKey: unsplashKey } });

    const first = await pull(frame.frame_id, frame.access_token);
    const etag = first.headers.get("etag")!;

    const cached = await pull(frame.frame_id, frame.access_token, {
      "if-none-match": etag,
    });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");

    await saveSettings({ unsplash: { accessKey: "rotated-unsplash-key" } });
    const rotated = await pull(frame.frame_id, frame.access_token, {
      "if-none-match": etag,
    });
    expect(rotated.status).toBe(200);
    await expect(rotated.json()).resolves.toEqual({
      groups: ["unsplash"],
      settings: { unsplash: { accessKey: "rotated-unsplash-key" } },
    });
  });

  it("backfills the declared groups for a frame assigned scenes before the column existed", async () => {
    const frame = await activeFrame();
    const scene = await createStoreScene(frame.accountId, "data/openaiImage");
    await assignScene(frame.frame_id, scene.id);
    await saveSettings({ openAI: { apiKey: openAiKey } });
    // Simulate the pre-migration state.
    await db
      .update(frames)
      .set({ serviceSettingGroups: null })
      .where(eq(frames.id, frame.frame_id));

    const response = await pull(frame.frame_id, frame.access_token);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      groups: ["openAI"],
      settings: { openAI: { apiKey: openAiKey } },
    });
    const [row] = await db
      .select({ groups: frames.serviceSettingGroups })
      .from(frames)
      .where(eq(frames.id, frame.frame_id));
    expect(row?.groups).toEqual(["openAI"]);
  });

  it("403s the moment the owner revokes the switch, and serves again when re-enabled", async () => {
    const frame = await activeFrame();
    const scene = await createStoreScene(frame.accountId, "data/unsplash");
    await assignScene(frame.frame_id, scene.id);
    await saveSettings({ unsplash: { accessKey: unsplashKey } });
    expect((await pull(frame.frame_id, frame.access_token)).status).toBe(200);

    const revoke = await setServiceSettingsEnabled(
      postJson(
        `/api/frames/${frame.frame_id}/service-settings/enabled`,
        { enabled: false },
        { origin: baseUrl },
      ),
      routeParams(frame.frame_id),
    );
    expect(revoke.status).toBe(200);
    // Revocation actually removes the scope from the linked client.
    const [client] = await db
      .select()
      .from(linkedClients)
      .where(eq(linkedClients.id, (await frameRow(frame.frame_id)).linkedClientId));
    expect(linkedClientScopes(client!)).not.toContain(frameServiceSettingsScope);

    const denied = await pull(frame.frame_id, frame.access_token);
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      error: "insufficient_scope",
    });

    const grant = await setServiceSettingsEnabled(
      postJson(
        `/api/frames/${frame.frame_id}/service-settings/enabled`,
        { enabled: true },
        { origin: baseUrl },
      ),
      routeParams(frame.frame_id),
    );
    expect(grant.status).toBe(200);
    expect((await pull(frame.frame_id, frame.access_token)).status).toBe(200);
  });

  it("refuses another frame's bearer and a frame that is not active", async () => {
    const frame = await activeFrame();
    const other = await activeFrame();

    const mismatch = await pull(other.frame_id, frame.access_token);
    expect(mismatch.status).toBe(403);
    await expect(mismatch.json()).resolves.toEqual({ error: "frame_mismatch" });

    await db
      .update(frames)
      .set({ status: "pending" })
      .where(eq(frames.id, frame.frame_id));
    const pending = await pull(frame.frame_id, frame.access_token);
    expect(pending.status).toBe(409);
    await expect(pending.json()).resolves.toEqual({ error: "frame_not_active" });
  });

  it("401s a garbage bearer", async () => {
    const frame = await activeFrame();

    const response = await pull(frame.frame_id, "fc_link_not_a_real_token");

    expect(response.status).toBe(401);
  });
});

describe("queue hygiene: no key ever enters frame_commands", () => {
  it("nudges with an empty payload on every settings save and keeps secrets out of the queue", async () => {
    const frame = await activeFrame();
    const scene = await createStoreScene(frame.accountId, "data/unsplash");
    await assignScene(frame.frame_id, scene.id);

    await saveSettings({ unsplash: { accessKey: unsplashKey } });
    await saveSettings({ openAI: { apiKey: openAiKey } });
    await setServiceSettingsEnabled(
      postJson(
        `/api/frames/${frame.frame_id}/service-settings/enabled`,
        { enabled: true },
        { origin: baseUrl },
      ),
      routeParams(frame.frame_id),
    );

    const nudges = await db
      .select()
      .from(frameCommands)
      .where(eq(frameCommands.type, "refresh_service_settings"));
    expect(nudges.length).toBeGreaterThan(0);
    for (const nudge of nudges) {
      // Zero payload, always. This is what keeps a deleted key from living
      // on in Postgres and in every backup.
      expect(nudge.payload).toEqual({});
      // Advisory: it expires rather than waking a frame days later.
      expect(nudge.expiresAt).not.toBeNull();
    }
    // Each save supersedes the previous nudge instead of piling up.
    expect(nudges.filter((row) => row.status === "pending")).toHaveLength(1);

    // The real assertion: NOTHING in the queue, of any type, carries a key.
    const everything = await db.select().from(frameCommands);
    const serialized = JSON.stringify(everything);
    expect(serialized).not.toContain(unsplashKey);
    expect(serialized).not.toContain(openAiKey);
    expect(serialized).not.toContain("accessKey");
    expect(serialized).not.toContain("apiKey");
  });

  it("does not nudge a frame whose owner turned the switch off", async () => {
    const frame = await activeFrame();
    await setServiceSettingsEnabled(
      postJson(
        `/api/frames/${frame.frame_id}/service-settings/enabled`,
        { enabled: false },
        { origin: baseUrl },
      ),
      routeParams(frame.frame_id),
    );
    await db.delete(frameCommands);

    await saveSettings({ unsplash: { accessKey: unsplashKey } });

    const nudges = await db
      .select()
      .from(frameCommands)
      .where(eq(frameCommands.type, "refresh_service_settings"));
    expect(nudges).toHaveLength(0);
  });
});

async function frameRow(frameId: string) {
  const [row] = await db.select().from(frames).where(eq(frames.id, frameId));
  if (!row) {
    throw new Error("frame not found");
  }
  return row;
}
