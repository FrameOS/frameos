import { strToU8, zipSync } from "fflate";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  createDb,
  storeSceneVersions,
  storeScenes,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as editSceneContent } from "../../../app/api/account/scenes/[sceneId]/content/route";
import { resetRateLimitForTests } from "../../lib/rate-limit";
import { createSession, sessionCookieName } from "../../lib/session";

// Renaming a scene in the web editor (gear → Rename) used to change only the
// scene inside scenes.json. The store listing's title — the <h1> on /s/[slug],
// the social card, the frameos:name meta tag — comes from storeScenes.name,
// which publishing reads out of the zip's template.json, so it kept showing the
// pre-rename title forever. Saving now carries the rename into both.

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
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
  const providerSubject = `rename-user-${userCounter}`;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Rename Tester ${userCounter}`,
    email: `rename-${userCounter}@example.com`,
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

function templateZip(name: string, scenes: unknown[]) {
  return Buffer.from(
    zipSync({
      [`${name}/template.json`]: strToU8(
        JSON.stringify({ description: "Pan and zoom", name }, null, 2),
      ),
      [`${name}/scenes.json`]: strToU8(JSON.stringify(scenes, null, 2)),
    }),
  );
}

async function seedScene(
  accountId: string,
  name: string,
  scenes: unknown[],
  slug = name.toLowerCase().replaceAll(" ", "-"),
) {
  const [scene] = await db
    .insert(storeScenes)
    .values({ accountId, latestVersion: 1, name, slug, visibility: "public" })
    .returning();
  const content = templateZip(name, scenes);
  await db.insert(storeSceneVersions).values({
    content,
    contentType: "application/zip",
    sceneId: scene!.id,
    sha256: "0".repeat(64),
    sizeBytes: content.length,
    version: 1,
  });
  return scene!.id;
}

function saveContent(sceneId: string, scenes: unknown[]) {
  return editSceneContent(
    new NextRequest(new URL(`/api/account/scenes/${sceneId}/content`, baseUrl), {
      body: JSON.stringify({ scenes }),
      headers: { "content-type": "application/json", origin: baseUrl },
      method: "POST",
    }),
    { params: Promise.resolve({ sceneId }) },
  );
}

async function storedName(sceneId: string) {
  const [row] = await db
    .select({ name: storeScenes.name, slug: storeScenes.slug })
    .from(storeScenes)
    .where(eq(storeScenes.id, sceneId));
  return row!;
}

describe("renaming a scene in the editor", () => {
  it("retitles the store listing, keeping the shared URL", async () => {
    const accountId = await signIn();
    const sceneId = await seedScene(accountId, "Ken Burns Slideshow", [
      { id: "scene-1", name: "Ken Burns Slideshow", nodes: [] },
    ]);

    const response = await saveContent(sceneId, [
      { id: "scene-1", name: "Ken Burns Deluxe", nodes: [] },
    ]);
    expect(response.status).toBe(200);

    const stored = await storedName(sceneId);
    expect(stored.name).toBe("Ken Burns Deluxe");
    // The slug is what people shared and what frames install from.
    expect(stored.slug).toBe("ken-burns-slideshow");
  });

  it("leaves the title alone when the scene was not renamed", async () => {
    const accountId = await signIn();
    const sceneId = await seedScene(accountId, "Ken Burns Slideshow", [
      { id: "scene-1", name: "Ken Burns Slideshow", nodes: [] },
    ]);

    const response = await saveContent(sceneId, [
      { id: "scene-1", name: "Ken Burns Slideshow", nodes: [{ id: "n1" }] },
    ]);
    expect(response.status).toBe(200);
    expect((await storedName(sceneId)).name).toBe("Ken Burns Slideshow");
  });

  it("leaves a listing titled differently from its scene alone", async () => {
    const accountId = await signIn();
    // The publisher deliberately titled the listing something else; a scene
    // rename must not hijack that.
    const sceneId = await seedScene(accountId, "Comics pack", [
      { id: "scene-1", name: "Main", nodes: [] },
    ]);

    const response = await saveContent(sceneId, [
      { id: "scene-1", name: "Home", nodes: [] },
    ]);
    expect(response.status).toBe(200);
    expect((await storedName(sceneId)).name).toBe("Comics pack");
  });

  it("refuses a rename that collides with another of the account's scenes", async () => {
    const accountId = await signIn();
    const sceneId = await seedScene(accountId, "Ken Burns Slideshow", [
      { id: "scene-1", name: "Ken Burns Slideshow", nodes: [] },
    ]);
    await seedScene(accountId, "Weather", [
      { id: "scene-2", name: "Weather", nodes: [] },
    ]);

    const response = await saveContent(sceneId, [
      { id: "scene-1", name: "weather", nodes: [] },
    ]);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("scene_name_taken");
    // Nothing was published: the rejected save left the scene untouched.
    const [scene] = await db
      .select({ latestVersion: storeScenes.latestVersion })
      .from(storeScenes)
      .where(eq(storeScenes.id, sceneId));
    expect(scene!.latestVersion).toBe(1);
  });
});
