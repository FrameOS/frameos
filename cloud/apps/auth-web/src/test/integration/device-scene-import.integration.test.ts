// Importing the scenes a frame was already running when it joined the cloud,
// against a real database (docs/cloud-frames.md, `scenes_get`).
//
// What is worth pinning: the frame ends up an ordinary cloud frame (drafts in
// the library, assigned, pushed with the active scene kept), and a frame that
// enrols AGAIN does not fork the library — the reason the ledger exists.

import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  createDb,
  frameCommands,
  frameDeviceScenes,
  frames,
  frameSceneAssignments,
  linkedClients,
  storeSceneImports,
  storeScenes,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissDeviceScenes,
  importDeviceScenes,
} from "../../lib/device-scene-import";
import {
  shouldRequestDeviceScenes,
  storeFrameDeviceScenes,
} from "../../lib/device-scenes";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const db = createDb();
let counter = 0;

async function account() {
  counter += 1;
  const { accountId } = await upsertAccountFromIdentity(db, {
    displayName: `Device Import User ${counter}`,
    email: `device-import-${counter}@example.com`,
    emailVerified: true,
    providerIssuer: "https://accounts.google.com",
    providerKey: "google",
    providerSubject: `device-import-user-${counter}`,
  });
  return accountId;
}

async function frameRow(accountId: string, status = "active") {
  counter += 1;
  const [client] = await db
    .insert(linkedClients)
    .values({
      accountId,
      clientKind: "frame",
      publicDisplayName: "Hallway",
      tokenReference: `device-import-frame-${counter}`,
    })
    .returning();
  const [frame] = await db
    .insert(frames)
    .values({
      accountId,
      linkedClientId: client!.id,
      name: "Hallway",
      publicKey: `device-import-key-${counter}`,
      status,
    })
    .returning();
  return frame!;
}

const clock = { edges: [], id: "clock", name: "Clock", nodes: [], settings: { execution: "interpreted" } };
const photos = { edges: [], id: "photos", name: "Photos", nodes: [], settings: { execution: "interpreted" } };

function report(scenes: unknown[], activeScene = "photos") {
  return Buffer.from(
    JSON.stringify({ active_scene: activeScene, scenes, skipped_compiled: 1 }),
  );
}

const actorFor = (accountId: string) => ({
  accountId,
  providerSubject: "device-import-test",
});

async function importFor(accountId: string, frameId: string, convertCompiled?: boolean) {
  const [frame] = await db.select().from(frames).where(eq(frames.id, frameId));
  return importDeviceScenes(db, {
    accountId,
    actor: actorFor(accountId),
    ...(convertCompiled ? { convertCompiled } : {}),
    frame: frame!,
  });
}

// A compiled scene whose one code node pass 1 converts (no model needed), and
// one with a source node nothing can port.
const legacy = {
  edges: [],
  id: "legacy",
  name: "Legacy",
  nodes: [{ data: { code: "1 + 2", codeArgs: [] }, id: "c1", type: "code" }],
  settings: { execution: "compiled" },
};
const stuck = {
  edges: [],
  id: "stuck",
  name: "Stuck",
  nodes: [{ data: { sources: { "app.nim": "discard" } }, id: "s1", type: "source" }],
  settings: { execution: "compiled" },
};

function compiledReport(scenes: unknown[], compiled: unknown[], unsent: unknown[] = []) {
  return Buffer.from(
    JSON.stringify({
      active_scene: "legacy",
      compiled_scenes: compiled,
      compiled_unsent: unsent,
      scenes,
      skipped_compiled: compiled.length + unsent.length,
    }),
  );
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("importing a frame's own scenes", () => {
  it("mints a draft per scene, assigns them and pushes with the active scene kept", async () => {
    const accountId = await account();
    const frame = await frameRow(accountId);
    await storeFrameDeviceScenes(db, frame.id, report([clock, photos]));

    const outcome = await importFor(accountId, frame.id);
    if (!outcome.ok) {
      throw new Error(`import failed: ${outcome.failure.code}`);
    }
    expect(outcome.result.status).toBe("imported");
    expect(outcome.result.imported.map((scene) => scene.name)).toEqual(["Clock", "Photos"]);
    expect(outcome.result.reused).toEqual([]);
    expect(outcome.result.assigned).toBe(2);
    expect(outcome.result.skipped_compiled).toBe(1);

    // Private drafts in the owner's library…
    const drafts = await db
      .select()
      .from(storeScenes)
      .where(eq(storeScenes.accountId, accountId));
    expect(drafts.map((scene) => scene.name).sort()).toEqual(["Clock", "Photos"]);
    expect(drafts.every((scene) => scene.visibility === "private")).toBe(true);

    // …assigned in the order the frame reported them…
    const assignments = await db
      .select()
      .from(frameSceneAssignments)
      .where(eq(frameSceneAssignments.frameId, frame.id))
      .orderBy(frameSceneAssignments.position);
    expect(assignments.map((row) => row.sceneId)).toEqual(
      outcome.result.imported.map((scene) => scene.scene_id),
    );

    // …and pushed, leaving what the frame was showing on screen.
    const [push] = await db
      .select()
      .from(frameCommands)
      .where(and(eq(frameCommands.frameId, frame.id), eq(frameCommands.type, "set_scenes")));
    const payload = push?.payload as { scene_id?: string; scenes?: { id: string }[] };
    expect(payload.scene_id).toBe("photos");
    expect(payload.scenes?.map((scene) => scene.id)).toEqual(["clock", "photos"]);
    expect(push?.id).toBe(outcome.result.command_id);

    // The snapshot is spent: verdict kept, bytes gone, and the hub stops asking.
    const [snapshot] = await db
      .select()
      .from(frameDeviceScenes)
      .where(eq(frameDeviceScenes.frameId, frame.id));
    expect(snapshot?.status).toBe("imported");
    expect(snapshot?.payload).toBeNull();
    const [after] = await db.select().from(frames).where(eq(frames.id, frame.id));
    expect(await shouldRequestDeviceScenes(db, after!, { scene_count: 2 })).toBe(false);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "frame.device_scenes_imported"));
    expect(audit.some((row) => (row.target as { frameId?: string }).frameId === frame.id)).toBe(true);
  });

  it("gives a re-enrolled frame the drafts it already has instead of forking them", async () => {
    const accountId = await account();
    const first = await frameRow(accountId);
    await storeFrameDeviceScenes(db, first.id, report([clock, photos]));
    const original = await importFor(accountId, first.id);
    if (!original.ok) {
      throw new Error(original.failure.code);
    }

    // The same card in a frame that enrols again (the old row deleted, or a
    // second row): it now reports the cloud's copies — `origin` stamped, keys
    // in whatever order the device serialized them — plus one new scene.
    const stamped = {
      settings: { execution: "interpreted" },
      origin: { storeSceneId: original.result.imported[0]!.scene_id, version: "1" },
      nodes: [],
      name: "Clock",
      id: "clock",
      edges: [],
    };
    const weather = { edges: [], id: "weather", name: "Weather", nodes: [] };
    const second = await frameRow(accountId);
    await storeFrameDeviceScenes(db, second.id, report([stamped, photos, weather], "clock"));
    const again = await importFor(accountId, second.id);
    if (!again.ok) {
      throw new Error(again.failure.code);
    }
    expect(again.result.reused.map((scene) => scene.scene_id)).toEqual(
      original.result.imported.map((scene) => scene.scene_id),
    );
    expect(again.result.imported.map((scene) => scene.name)).toEqual(["Weather"]);
    expect(again.result.assigned).toBe(3);

    const drafts = await db
      .select()
      .from(storeScenes)
      .where(eq(storeScenes.accountId, accountId));
    expect(drafts.map((scene) => scene.name).sort()).toEqual(["Clock", "Photos", "Weather"]);
    const ledger = await db
      .select()
      .from(storeSceneImports)
      .where(eq(storeSceneImports.accountId, accountId));
    expect(ledger).toHaveLength(3);
  });

  it("imports an edited scene as a new draft, and a deleted draft again", async () => {
    const accountId = await account();
    const first = await frameRow(accountId);
    await storeFrameDeviceScenes(db, first.id, report([clock]));
    const original = await importFor(accountId, first.id);
    if (!original.ok) {
      throw new Error(original.failure.code);
    }

    // Edited on the frame since: different content, so neither copy is
    // overwritten — it lands next to the first as "Clock 2".
    const edited = { ...clock, nodes: [{ id: "n1", type: "event", data: { keyword: "render" } }] };
    const second = await frameRow(accountId);
    await storeFrameDeviceScenes(db, second.id, report([edited], "clock"));
    const changed = await importFor(accountId, second.id);
    expect(changed.ok && changed.result.imported).toHaveLength(1);
    expect(changed.ok && changed.result.reused).toHaveLength(0);

    // The ledger row died with its scene: nothing to reuse, import again.
    await db.delete(storeScenes).where(eq(storeScenes.id, original.result.imported[0]!.scene_id));
    const third = await frameRow(accountId);
    await storeFrameDeviceScenes(db, third.id, report([clock], "clock"));
    const reimported = await importFor(accountId, third.id);
    expect(reimported.ok && reimported.result.imported).toHaveLength(1);
  });

  it("adds to what the frame already has, and keeps another account's ledger out of it", async () => {
    const accountId = await account();
    const stranger = await account();
    const strangerFrame = await frameRow(stranger);
    await storeFrameDeviceScenes(db, strangerFrame.id, report([clock]));
    const theirs = await importFor(stranger, strangerFrame.id);
    if (!theirs.ok) {
      throw new Error(theirs.failure.code);
    }

    const frame = await frameRow(accountId);
    await storeFrameDeviceScenes(db, frame.id, report([clock], "clock"));
    const mine = await importFor(accountId, frame.id);
    if (!mine.ok) {
      throw new Error(mine.failure.code);
    }
    // Same bytes, different account: a draft of my own, never theirs.
    expect(mine.result.reused).toEqual([]);
    expect(mine.result.imported[0]!.scene_id).not.toBe(theirs.result.imported[0]!.scene_id);
  });

  it("grants an imported scene NO service keys, whatever the device made it declare", async () => {
    // Claim-token enrolments hold settings:services by default, and what a
    // scene declares is the device's say. If importing granted "what the
    // scenes declare", a frame that is not the owner's could declare every
    // group and pull the account's keys on one click of a banner that never
    // mentions them.
    const accountId = await account();
    const frame = await frameRow(accountId);
    const greedy = {
      edges: [],
      id: "greedy",
      name: "Greedy",
      nodes: [
        { data: { config: {}, keyword: "data/unsplash" }, id: "u1", type: "app" },
        { data: { config: {}, keyword: "data/openaiImage" }, id: "o1", type: "app" },
      ],
    };
    await storeFrameDeviceScenes(db, frame.id, report([greedy], "greedy"));
    const outcome = await importFor(accountId, frame.id);
    if (!outcome.ok) {
      throw new Error(outcome.failure.code);
    }
    // Told, not granted: the owner grants in the frame's settings.
    expect(outcome.result.imported[0]?.needs_settings_groups?.sort()).toEqual(["openAI", "unsplash"]);
    const [assignment] = await db
      .select()
      .from(frameSceneAssignments)
      .where(eq(frameSceneAssignments.frameId, frame.id));
    expect(assignment?.grantedSettingsGroups).toEqual([]);
    expect((assignment?.declaredSettingsGroups as string[]).sort()).toEqual(["openAI", "unsplash"]);
    const [after] = await db.select().from(frames).where(eq(frames.id, frame.id));
    // The union the device's key pull is answered from.
    expect(after?.serviceSettingGroups).toEqual([]);
  });

  it("an account at its daily limit is refused before anything is minted", async () => {
    const accountId = await account();
    await db.insert(storeScenes).values(
      Array.from({ length: 19 }, (_, index) => ({
        accountId,
        latestVersion: 1,
        name: `Filler ${index}`,
        slug: `device-import-filler-${accountId}-${index}`,
        status: "active",
      })),
    );
    const frame = await frameRow(accountId);
    await storeFrameDeviceScenes(db, frame.id, report([clock, photos], "clock"));

    // One slot left today: the first scene lands, the second never starts —
    // no draft, and so no moderation or classifier call spent on it.
    const outcome = await importFor(accountId, frame.id);
    if (!outcome.ok) {
      throw new Error(outcome.failure.code);
    }
    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.imported.map((scene) => scene.name)).toEqual(["Clock"]);
    expect(outcome.result.skipped).toEqual([
      { device_scene_id: "photos", name: "Photos", reason: "daily_scene_limit_exceeded" },
    ]);
    const mine = await db.select().from(storeScenes).where(eq(storeScenes.accountId, accountId));
    expect(mine).toHaveLength(20);
    // The report keeps waiting, so "Import the rest" works tomorrow.
    const [snapshot] = await db
      .select()
      .from(frameDeviceScenes)
      .where(eq(frameDeviceScenes.frameId, frame.id));
    expect(snapshot?.status).toBe("ready");
    expect(snapshot?.payload).not.toBeNull();
  });

  it("refuses a pending frame, an empty snapshot and a second import at once", async () => {
    const accountId = await account();
    const pending = await frameRow(accountId, "pending");
    await storeFrameDeviceScenes(db, pending.id, report([clock]));
    const refused = await importFor(accountId, pending.id);
    expect(refused).toMatchObject({ failure: { code: "frame_not_active" }, ok: false });

    const bare = await frameRow(accountId);
    expect(await importFor(accountId, bare.id)).toMatchObject({
      failure: { code: "nothing_to_import", status: 404 },
      ok: false,
    });

    // A live claim blocks a second import; a stale one is taken over.
    const busy = await frameRow(accountId);
    await storeFrameDeviceScenes(db, busy.id, report([clock], "clock"));
    await db
      .update(frameDeviceScenes)
      .set({ status: "importing", statusAt: new Date() })
      .where(eq(frameDeviceScenes.frameId, busy.id));
    expect(await importFor(accountId, busy.id)).toMatchObject({
      failure: { code: "import_in_progress", status: 409 },
      ok: false,
    });
    await db
      .update(frameDeviceScenes)
      .set({ statusAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(frameDeviceScenes.frameId, busy.id));
    expect((await importFor(accountId, busy.id)).ok).toBe(true);
  });

  it("converts the frame's compiled scenes only when asked, and keeps the report until then", async () => {
    // No model in this test: pass 1 converts `legacy` on its own.
    vi.stubEnv("OPENAI_API_KEY", "");
    const accountId = await account();
    const frame = await frameRow(accountId);
    await storeFrameDeviceScenes(
      db,
      frame.id,
      compiledReport([clock], [legacy, stuck], [{ id: "binary", name: "Binary" }]),
    );
    const [stored] = await db
      .select()
      .from(frameDeviceScenes)
      .where(eq(frameDeviceScenes.frameId, frame.id));
    expect(stored?.compiledScenes).toEqual([
      { id: "legacy", name: "Legacy", sent: true },
      { id: "stuck", name: "Stuck", sent: true },
      { id: "binary", name: "Binary", sent: false },
    ]);

    // A plain import takes the interpreted scene and leaves the report open
    // for the compiled ones: nothing converts unless the owner says so.
    const plain = await importFor(accountId, frame.id);
    if (!plain.ok) {
      throw new Error(plain.failure.code);
    }
    expect(plain.result.imported.map((scene) => scene.name)).toEqual(["Clock"]);
    expect(plain.result.skipped_compiled).toBe(3);
    const [open] = await db
      .select()
      .from(frameDeviceScenes)
      .where(eq(frameDeviceScenes.frameId, frame.id));
    expect(open?.status).toBe("ready");
    expect(open?.payload).not.toBeNull();

    const converted = await importFor(accountId, frame.id, true);
    if (!converted.ok) {
      throw new Error(converted.failure.code);
    }
    expect(converted.result.reused.map((scene) => scene.name)).toEqual(["Clock"]);
    expect(converted.result.imported).toMatchObject([{ converted: true, name: "Legacy" }]);
    expect(converted.result.skipped).toEqual([
      { device_scene_id: "stuck", name: "Stuck", reason: "conversion_incomplete" },
    ]);
    // Only the scene the frame could not send is left untried.
    expect(converted.result.skipped_compiled).toBe(1);
    expect(converted.result.status).toBe("imported");

    // The push carries the converted scene under its own id, so the scene on
    // screen stays on screen (and the frame carries its state over).
    const pushes = await db
      .select()
      .from(frameCommands)
      .where(and(eq(frameCommands.frameId, frame.id), eq(frameCommands.type, "set_scenes")));
    const last = pushes.find((push) => push.id === converted.result.command_id);
    const payload = last?.payload as {
      scene_id?: string;
      scenes?: { id: string; nodes?: { data?: Record<string, unknown> }[]; settings?: Record<string, unknown> }[];
    };
    expect(payload.scene_id).toBe("legacy");
    const pushed = payload.scenes?.find((scene) => scene.id === "legacy");
    expect(pushed?.settings?.execution).toBe("interpreted");
    expect(pushed?.nodes?.[0]?.data?.codeJS).toBeTruthy();
    expect(pushed?.nodes?.[0]?.data?.code).toBeUndefined();

    // The same compiled scene from a re-enrolled frame is the draft already
    // made, found by what the frame holds: no second conversion, no copy.
    const second = await frameRow(accountId);
    await storeFrameDeviceScenes(db, second.id, compiledReport([], [legacy]));
    const again = await importFor(accountId, second.id, true);
    if (!again.ok) {
      throw new Error(again.failure.code);
    }
    expect(again.result.imported).toEqual([]);
    expect(again.result.reused).toMatchObject([
      { converted: true, scene_id: converted.result.imported[0]!.scene_id },
    ]);
  });

  it("keeps a report of compiled scenes only, which a plain import does not touch", async () => {
    const accountId = await account();
    const frame = await frameRow(accountId);
    await storeFrameDeviceScenes(
      db,
      frame.id,
      compiledReport([], [], [{ id: "binary", name: "Binary" }]),
    );
    expect(await importFor(accountId, frame.id)).toMatchObject({
      failure: { code: "nothing_to_import", status: 404 },
      ok: false,
    });
    // Still there for the banner to explain, and for "Not now" to close.
    const [snapshot] = await db
      .select()
      .from(frameDeviceScenes)
      .where(eq(frameDeviceScenes.frameId, frame.id));
    expect(snapshot?.status).toBe("ready");
    expect(
      await dismissDeviceScenes(db, { accountId, actor: actorFor(accountId), frame }),
    ).toBe(true);
  });

  it("dismiss drops the bytes, keeps the verdict and is not reopened by a late reply", async () => {
    const accountId = await account();
    const frame = await frameRow(accountId);
    await storeFrameDeviceScenes(db, frame.id, report([clock, photos]));
    expect(
      await dismissDeviceScenes(db, { accountId, actor: actorFor(accountId), frame }),
    ).toBe(true);
    // A reply to a question asked before the verdict changes nothing.
    await storeFrameDeviceScenes(db, frame.id, report([clock, photos]));
    const [snapshot] = await db
      .select()
      .from(frameDeviceScenes)
      .where(eq(frameDeviceScenes.frameId, frame.id));
    expect(snapshot?.status).toBe("dismissed");
    expect(snapshot?.payload).toBeNull();
    expect(await shouldRequestDeviceScenes(db, frame, { scene_count: 2 })).toBe(false);
    expect(
      await dismissDeviceScenes(db, { accountId, actor: actorFor(accountId), frame }),
    ).toBe(false);
  });
});
