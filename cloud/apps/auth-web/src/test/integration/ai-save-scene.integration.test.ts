// The chat agent's save_scene tool, against a real database.
//
// Two behaviours worth pinning. First, lineage: "save this store scene for
// me" is a FORK, and a fork that records none of where it came from is how
// the account ends up full of orphan copies. With `source_scene_id` the tool
// must go through the same path the workspace's fork button uses — preview
// image, tags and description carried over, `store.scene_forked` naming the
// source — and must refuse a source the user cannot read. Second, the name
// race: picking a free name and then inserting it is a check-then-act, and
// two concurrent saves used to both land on the same "name 2".

import { and, eq, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import {
  auditEvents,
  createDb,
  storeImages,
  storeSceneVersionImages,
  storeScenes,
  storeSceneVersions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readBlob } from "../../lib/blobs";
import { extractScenesFromZip } from "../../lib/scene-title";
import { imageSetForVersion, registerStoreImage } from "../../lib/store-images";
import { executeTool, type ToolContext } from "../../lib/ai/tools";

// recordAuditEvent reads request headers for the client IP; there is no
// request scope here, and it already tolerates that.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const db = createDb();
const issuer = "https://accounts.google.com";
let userCounter = 0;
let sceneCounter = 0;

async function account() {
  userCounter += 1;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `AI Save User ${userCounter}`,
    email: `ai-save-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject: `ai-save-user-${userCounter}`,
  });
  return accountId;
}

const previewBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 7, 0, 0, 0, 0, 0, 0, 0]);

function sceneZip(name: string, scenes: unknown[]) {
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  return Buffer.from(
    zipSync({
      "scene/scenes.json": encode(scenes),
      "scene/template.json": encode({ name, scenes: "./scenes.json" }),
    }),
  );
}

/** A published-looking store scene with everything a fork should carry:
 * a listing and a two-image set (cover first) on its one version. */
async function storeScene(
  accountId: string,
  options: { name: string; visibility?: "private" | "public" } = {
    name: "Sunrise clock",
  },
) {
  sceneCounter += 1;
  const scenes = [
    { edges: [], id: `source-${sceneCounter}`, name: options.name, nodes: [] },
  ];
  const [scene] = await db
    .insert(storeScenes)
    .values({
      accountId,
      description: "Wakes up with the sun",
      latestVersion: 1,
      name: options.name,
      slug: `${options.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${sceneCounter}`,
      status: "active",
      tags: ["clock", "sunrise"],
      visibility: options.visibility ?? "public",
    })
    .returning();
  if (!scene) {
    throw new Error("scene insert failed");
  }
  const [version] = await db
    .insert(storeSceneVersions)
    .values({
      content: sceneZip(options.name, scenes),
      contentType: "application/zip",
      description: "Wakes up with the sun",
      listingRecorded: true,
      riskFlags: [],
      sceneId: scene.id,
      sha256: `test-${sceneCounter}`,
      sizeBytes: 1000,
      tags: ["clock", "sunrise"],
      version: 1,
    })
    .returning({ id: storeSceneVersions.id });
  const cover = await registerStoreImage(db, previewBytes, "image/jpeg");
  const gallery = await registerStoreImage(db, Buffer.from([0x89, 0x50, 0x4e, 0x47, 3]), "image/png");
  await db.insert(storeSceneVersionImages).values([
    { imageSha256: cover.sha256, position: 0, versionId: version!.id },
    { imageSha256: gallery.sha256, position: 1, versionId: version!.id },
  ]);
  return { images: [cover.sha256, gallery.sha256], scene, scenes };
}

function toolContext(accountId: string): ToolContext {
  return {
    accountId,
    db,
    emitScenes: () => undefined,
    prompt: "save this one to my account",
    providerSubject: `ai-save-user-${userCounter}`,
  };
}

async function saveScene(accountId: string, args: Record<string, unknown>) {
  const output = await executeTool("save_scene", args, toolContext(accountId));
  return JSON.parse(output) as Record<string, unknown> & {
    scene?: { id?: string; name?: string } | null;
  };
}

async function savedScene(sceneId: string) {
  const [row] = await db
    .select()
    .from(storeScenes)
    .where(eq(storeScenes.id, sceneId));
  return row;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("save_scene", () => {
  it("saves a brand-new scene as a private scene of its own", async () => {
    const accountId = await account();

    const result = await saveScene(accountId, {
      name: "Hand built",
      scenes: [{ edges: [], id: "fresh", name: "Hand built", nodes: [] }],
    });

    expect(result.ok).toBe(true);
    const saved = await savedScene(result.scene?.id as string);
    expect(saved).toMatchObject({
      accountId,
      name: "Hand built",
      visibility: "private",
    });
    // Nothing to inherit: a scene built in the chat has no source.
    expect(await imageSetForVersion(db, saved!.id, null)).toEqual([]);
    expect(saved?.tags).toEqual([]);
  });

  it("forks with lineage when the scene came from the store", async () => {
    const owner = await account();
    const { images, scene: source, scenes } = await storeScene(owner, {
      name: "Sunrise clock",
    });
    const forker = await account();

    const result = await saveScene(forker, {
      scenes: scenes.map((scene) => ({ ...scene, nodes: [{ id: "added" }] })),
      source_scene_id: source.id,
    });

    expect(result.ok).toBe(true);
    expect(result.note).toMatch(/forked/i);
    const forked = await savedScene(result.scene?.id as string);
    expect(forked).toMatchObject({
      accountId: forker,
      description: source.description,
      name: "Sunrise clock (copy)",
      tags: ["clock", "sunrise"],
      visibility: "private",
    });
    // The image set comes along as links to the same rows — the cover
    // first — and nothing was copied.
    expect((await imageSetForVersion(db, forked!.id, null)).map((image) => image.sha256)).toEqual(images);
    const [imageRows] = await db.select({ count: sql<number>`count(*)::int` }).from(storeImages);
    expect(imageRows?.count).toBe(2);

    // The edit the chat made is what got saved, not the source bytes.
    const [version] = await db
      .select()
      .from(storeSceneVersions)
      .where(eq(storeSceneVersions.sceneId, forked!.id));
    const content = await readBlob(version!);
    expect(content).toBeTruthy();
    expect(JSON.stringify(extractScenesFromZip(content!))).toContain("added");

    // The lineage the dedicated fork route records, from the chat too.
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.accountId, forker),
          eq(auditEvents.eventType, "store.scene_forked"),
        ),
      );
    expect(event?.metadata).toMatchObject({
      name: "Sunrise clock (copy)",
      sourceSceneId: source.id,
      sourceSceneName: "Sunrise clock",
      via: "ai_chat",
    });
    expect(event?.target).toMatchObject({ sceneId: forked!.id });
  });

  it("refuses a source the user cannot read, and saves nothing", async () => {
    const owner = await account();
    const { scene: source, scenes } = await storeScene(owner, {
      name: "Private notes",
      visibility: "private",
    });
    const stranger = await account();

    const result = await saveScene(stranger, {
      scenes,
      source_scene_id: source.id,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("scene_not_found");
    expect(
      await db
        .select()
        .from(storeScenes)
        .where(eq(storeScenes.accountId, stranger)),
    ).toEqual([]);
  });

  it("rejects a source id that is not a scene id before touching the db", async () => {
    const accountId = await account();

    const result = await saveScene(accountId, {
      scenes: [{ edges: [], id: "fresh", name: "Fresh", nodes: [] }],
      source_scene_id: "the one we talked about",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/source_scene_id/);
  });

  // The bug this guards: availableSceneName checked, then the insert ran, and
  // two saves racing through that gap both saw "Sunrise 7" free.
  it("gives concurrent saves of the same name distinct names", async () => {
    const accountId = await account();

    const results = await Promise.all([
      saveScene(accountId, {
        name: "Racing scene",
        scenes: [{ edges: [], id: "a", name: "Racing scene", nodes: [] }],
      }),
      saveScene(accountId, {
        name: "Racing scene",
        scenes: [{ edges: [], id: "b", name: "Racing scene", nodes: [] }],
      }),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    const rows = await db
      .select({ name: storeScenes.name })
      .from(storeScenes)
      .where(eq(storeScenes.accountId, accountId));
    expect(rows.map((row) => row.name).sort()).toEqual([
      "Racing scene",
      "Racing scene 2",
    ]);
  });

  // Same race on the fork path: both forks of one source want "(copy)".
  it("gives concurrent forks of one scene distinct names", async () => {
    const owner = await account();
    const { scene: source, scenes } = await storeScene(owner, {
      name: "Busy scene",
    });
    const forker = await account();

    const results = await Promise.all([
      saveScene(forker, { scenes, source_scene_id: source.id }),
      saveScene(forker, { scenes, source_scene_id: source.id }),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    const rows = await db
      .select({ name: storeScenes.name })
      .from(storeScenes)
      .where(eq(storeScenes.accountId, forker));
    // ASCII order: the space in "(copy 2)" sorts before the ")".
    expect(rows.map((row) => row.name).sort()).toEqual([
      "Busy scene (copy 2)",
      "Busy scene (copy)",
    ]);
  });
});
