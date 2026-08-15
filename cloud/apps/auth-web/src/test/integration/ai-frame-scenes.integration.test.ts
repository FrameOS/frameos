// The chat agent's add_scene_to_frame tool, against a real database.
//
// This is the one tool that changes what a physical frame displays, so the
// behaviour worth pinning is not "it writes a row" but the delta semantics
// the tool adds on top of the shared assignment helper: adding a second
// scene must KEEP the first (the underlying push is a wholesale replacement,
// so an append that forgets to re-send the existing set silently wipes the
// frame), and re-adding an assigned scene must re-deploy rather than
// duplicate (the assignments table has a unique index on frame+scene).

import { eq } from "drizzle-orm";
import { zipSync } from "fflate";
import {
  createDb,
  frameCommands,
  frames,
  frameSceneAssignments,
  linkedClients,
  storeScenes,
  storeSceneVersions,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
let frameCounter = 0;

async function account() {
  userCounter += 1;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `AI Tools User ${userCounter}`,
    email: `ai-tools-${userCounter}@example.com`,
    emailVerified: true,
    providerIssuer: issuer,
    providerKey: "google",
    providerSubject: `ai-tools-user-${userCounter}`,
  });
  return accountId;
}

// A cloud-managed frame in the given status. The enrollment handshake is
// covered by frames.integration.test.ts; what matters here is a frame row
// owned by the account, with the linked client every frame hangs off.
async function frameRow(
  accountId: string,
  { name = "Kitchen frame", status = "active" as string } = {},
) {
  frameCounter += 1;
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      publicDisplayName: name,
      tokenReference: `ai-tools-frame-${frameCounter}`,
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      linkedClientId: client!.id,
      name,
      publicKey: `ai-tools-frame-key-${frameCounter}`,
      status,
    })
    .returning();
  if (!frame) {
    throw new Error("frame insert failed");
  }
  return frame;
}

const activeFrame = (accountId: string, name?: string) =>
  frameRow(accountId, name === undefined ? {} : { name });

function sceneZip(sceneId: string) {
  const scenes = [{ edges: [], id: sceneId, name: `Scene ${sceneId}`, nodes: [] }];
  return Buffer.from(
    zipSync({
      "scene/scenes.json": new TextEncoder().encode(JSON.stringify(scenes)),
      "scene/template.json": new TextEncoder().encode(
        JSON.stringify({ name: `Scene ${sceneId}` }),
      ),
    }),
  );
}

async function storeScene(
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
      slug: `${options.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${userCounter}`,
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

function toolContext(accountId: string): ToolContext {
  return {
    accountId,
    db,
    emitScenes: () => undefined,
    prompt: "put the bird journal on the kitchen frame",
  };
}

async function addSceneToFrame(
  accountId: string,
  args: Record<string, unknown>,
) {
  const output = await executeTool(
    "add_scene_to_frame",
    args,
    toolContext(accountId),
  );
  return JSON.parse(output) as Record<string, unknown>;
}

async function assignmentIds(frameId: string) {
  const rows = await db
    .select({ sceneId: frameSceneAssignments.sceneId })
    .from(frameSceneAssignments)
    .where(eq(frameSceneAssignments.frameId, frameId))
    .orderBy(frameSceneAssignments.position);
  return rows.map((row) => row.sceneId);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("add_scene_to_frame", () => {
  it("installs the scene and queues the deploy", async () => {
    const accountId = await account();
    const frame = await activeFrame(accountId);
    const scene = await storeScene(accountId, { name: "Bird field journal" });

    const result = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: scene.id,
    });

    expect(result.deployed).toBe(true);
    expect(result.assigned_scenes).toEqual(["Bird field journal"]);
    expect(await assignmentIds(frame.id)).toEqual([scene.id]);

    // The deploy: a set_scenes command carrying the same checksum the frame
    // row now advertises as assigned.
    const commands = await db
      .select()
      .from(frameCommands)
      .where(eq(frameCommands.frameId, frame.id));
    expect(commands).toHaveLength(1);
    expect(commands[0]?.type).toBe("set_scenes");
    const [frameRow] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame.id));
    const payload = commands[0]?.payload as { checksum: string };
    expect(payload.checksum).toBe(frameRow?.assignedChecksum);
    expect(payload.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the scenes already on the frame", async () => {
    const accountId = await account();
    const frame = await activeFrame(accountId);
    const first = await storeScene(accountId, { name: "Clock" });
    const second = await storeScene(accountId, { name: "Weather" });

    await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: first.id,
    });
    const result = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: second.id,
    });

    expect(await assignmentIds(frame.id)).toEqual([first.id, second.id]);
    expect(result.assigned_scenes).toEqual(["Clock", "Weather"]);
  });

  it("re-deploys an already assigned scene instead of duplicating it", async () => {
    const accountId = await account();
    const frame = await activeFrame(accountId);
    const scene = await storeScene(accountId, { name: "Clock" });

    await addSceneToFrame(accountId, { frame_id: frame.id, scene_id: scene.id });
    const result = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: scene.id,
    });

    expect(result.re_deployed).toBe(true);
    expect(result.deployed).toBe(true);
    expect(await assignmentIds(frame.id)).toEqual([scene.id]);
  });

  it("refuses a scene that runs shell commands", async () => {
    const accountId = await account();
    const frame = await activeFrame(accountId);
    const scene = await storeScene(accountId, {
      name: "Shell scene",
      riskFlags: ["shell"],
    });

    const result = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: scene.id,
    });

    expect(result.error).toMatch(/shell commands/i);
    expect(await assignmentIds(frame.id)).toEqual([]);
  });

  it("refuses another account's private scene", async () => {
    const accountId = await account();
    const frame = await activeFrame(accountId);
    const strangerId = await account();
    const scene = await storeScene(strangerId, { name: "Someone elses" });

    const result = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: scene.id,
    });

    expect(result.error).toBe("invalid_scene");
    expect(await assignmentIds(frame.id)).toEqual([]);
  });

  it("refuses a frame in another account", async () => {
    const accountId = await account();
    const strangerId = await account();
    const frame = await activeFrame(strangerId);
    const scene = await storeScene(accountId, { name: "Clock" });

    await expect(
      executeTool(
        "add_scene_to_frame",
        { frame_id: frame.id, scene_id: scene.id },
        toolContext(accountId),
      ),
    ).rejects.toThrow(/No frame with id/);
  });

  it("refuses a frame the owner has not confirmed yet", async () => {
    const accountId = await account();
    const frame = await frameRow(accountId, {
      name: "Unconfirmed",
      status: "pending",
    });
    const scene = await storeScene(accountId, { name: "Clock" });

    const result = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: scene.id,
    });

    expect(result.error).toMatch(/not active/i);
    expect(await assignmentIds(frame.id)).toEqual([]);
  });
});
