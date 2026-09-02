// The chat agent's add_scene_to_frame tool, against a real database.
//
// This is the one tool about changing what a physical frame displays, and
// the property worth pinning is that it changes NOTHING: everything the model
// read on the way here (store listings, scene JSON, frame logs) is untrusted
// text, so the tool only checks the read-only gates and emits a proposal
// the user approves in the UI. Approve calls POST /api/frames/{id}/scenes,
// which runs every gate again. So: no assignment row, no set_scenes command,
// and a proposal that names the frame, the scene and the settings groups
// the install would hand the frame.

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
import {
  executeTool,
  type InstallProposalEvent,
  type ToolContext,
} from "../../lib/ai/tools";

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

function sceneZip(sceneId: string, nodes: unknown[] = []) {
  const scenes = [{ edges: [], id: sceneId, name: `Scene ${sceneId}`, nodes }];
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
    // App nodes of the single scene; a data/unsplash node makes the scene
    // declare the `unsplash` settings group.
    nodes?: unknown[];
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
    content: sceneZip(scene.id, options.nodes),
    contentType: "application/zip",
    riskFlags: options.riskFlags ?? [],
    sceneId: scene.id,
    sha256: "test",
    sizeBytes: 1000,
    version: 1,
  });
  return scene;
}

type Harness = { ctx: ToolContext; proposals: InstallProposalEvent[] };

function toolContext(accountId: string): Harness {
  const proposals: InstallProposalEvent[] = [];
  return {
    ctx: {
      accountId,
      db,
      emitProposal: (event) => proposals.push(event),
      emitScenes: () => undefined,
      prompt: "put the bird journal on the kitchen frame",
    },
    proposals,
  };
}

async function addSceneToFrame(
  accountId: string,
  args: Record<string, unknown>,
) {
  const harness = toolContext(accountId);
  const output = await executeTool("add_scene_to_frame", args, harness.ctx);
  return { proposals: harness.proposals, result: JSON.parse(output) as Record<string, unknown> };
}

async function assignmentIds(frameId: string) {
  const rows = await db
    .select({ sceneId: frameSceneAssignments.sceneId })
    .from(frameSceneAssignments)
    .where(eq(frameSceneAssignments.frameId, frameId))
    .orderBy(frameSceneAssignments.position);
  return rows.map((row) => row.sceneId);
}

async function commandsFor(frameId: string) {
  return db.select().from(frameCommands).where(eq(frameCommands.frameId, frameId));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("add_scene_to_frame", () => {
  it("proposes the install and changes nothing on the frame", async () => {
    const accountId = await account();
    const frame = await activeFrame(accountId);
    const scene = await storeScene(accountId, { name: "Bird field journal" });

    const { proposals, result } = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: scene.id,
    });

    expect(result.status).toBe("awaiting_approval");
    expect(result.deployed).toBeUndefined();
    expect(result.note).toMatch(/NOTHING has been installed/);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      already_assigned: false,
      declared_settings_groups: [],
      frame: { connected: false, id: frame.id, name: "Kitchen frame", status: "active" },
      kind: "install_scene",
      scene: { id: scene.id, name: "Bird field journal", version: null },
      type: "proposal",
    });
    expect(proposals[0]?.proposal_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.proposal_id).toBe(proposals[0]?.proposal_id);

    // The point: no assignment, no deploy, no frame-row change.
    expect(await assignmentIds(frame.id)).toEqual([]);
    expect(await commandsFor(frame.id)).toHaveLength(0);
    const [frameRow] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(frameRow?.assignedChecksum).toBeNull();
  });

  // What the card shows: the keys the install would hand the frame. Read
  // from the version's own scenes, so the model cannot claim otherwise.
  it("names the settings groups the scene declares", async () => {
    const accountId = await account();
    const frame = await activeFrame(accountId);
    const scene = await storeScene(accountId, {
      name: "Unsplash wall",
      nodes: [{ data: { config: {}, keyword: "data/unsplash" }, id: "u1", type: "app" }],
    });

    const { proposals, result } = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: scene.id,
      scene_version: 1,
    });

    expect(result.declared_settings_groups).toEqual(["unsplash"]);
    expect(proposals[0]?.declared_settings_groups).toEqual(["unsplash"]);
    expect(proposals[0]?.scene.version).toBe(1);
    expect(await assignmentIds(frame.id)).toEqual([]);
  });

  it("flags a scene that is already on the frame as a re-deploy", async () => {
    const accountId = await account();
    const frame = await activeFrame(accountId);
    const scene = await storeScene(accountId, { name: "Clock" });
    await db.insert(frameSceneAssignments).values({
      frameId: frame.id,
      position: 0,
      sceneId: scene.id,
      sceneVersion: null,
    });

    const { proposals, result } = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: scene.id,
    });

    expect(result.already_assigned).toBe(true);
    expect(proposals[0]?.already_assigned).toBe(true);
    expect(await commandsFor(frame.id)).toHaveLength(0);
  });

  it("refuses a scene that runs shell commands", async () => {
    const accountId = await account();
    const frame = await activeFrame(accountId);
    const scene = await storeScene(accountId, {
      name: "Shell scene",
      riskFlags: ["shell"],
    });

    const { proposals, result } = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: scene.id,
    });

    expect(result.error).toMatch(/shell commands/i);
    expect(proposals).toHaveLength(0);
  });

  it("refuses a version that does not exist", async () => {
    const accountId = await account();
    const frame = await activeFrame(accountId);
    const scene = await storeScene(accountId, { name: "Clock" });

    const { proposals, result } = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: scene.id,
      scene_version: 7,
    });

    expect(result.error).toBe("scene_version_missing");
    expect(proposals).toHaveLength(0);
  });

  it("refuses another account's private scene", async () => {
    const accountId = await account();
    const frame = await activeFrame(accountId);
    const strangerId = await account();
    const scene = await storeScene(strangerId, { name: "Someone elses" });

    const { proposals, result } = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: scene.id,
    });

    expect(result.error).toBe("invalid_scene");
    expect(proposals).toHaveLength(0);
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
        toolContext(accountId).ctx,
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

    const { proposals, result } = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: scene.id,
    });

    expect(result.error).toMatch(/not active/i);
    expect(proposals).toHaveLength(0);
  });

  it("refuses when the frame is full", async () => {
    const accountId = await account();
    const frame = await activeFrame(accountId);
    for (let index = 0; index < 20; index += 1) {
      const filler = await storeScene(accountId, { name: `Filler ${index}` });
      await db.insert(frameSceneAssignments).values({
        frameId: frame.id,
        position: index,
        sceneId: filler.id,
        sceneVersion: null,
      });
    }
    const scene = await storeScene(accountId, { name: "One too many" });

    const { proposals, result } = await addSceneToFrame(accountId, {
      frame_id: frame.id,
      scene_id: scene.id,
    });

    expect(result.error).toMatch(/at most 20 scenes/);
    expect(proposals).toHaveLength(0);
  });
});
