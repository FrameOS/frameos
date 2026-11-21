import { and, desc, eq, isNull } from "drizzle-orm";
import { createDb, frames, storeScenes, storeSceneVersions } from "@frameos-cloud/db";
import { isBrokenLayout, sceneLayoutProblem } from "../../../../../frontend/src/utils/sceneLayoutRule";
import { createAccountScene } from "./account-scene-create";
import { keepAppTestFiles } from "./retired-apps";
import { resolveAiAccess } from "./ai/api-key";
import { frameContextBlock } from "./ai/frame-context";
import { OpenAiRequestError } from "./ai/openai";
import type { JsonObject } from "./ai/scene-utils";
import { inFlightSpendMicros } from "./ai/spend-reservations";
import { buildSceneByVoice } from "./ai/voice-scene-builder";
import { recordAuditEvent } from "./audit";
import { meterAiUsageInBackground } from "./billing";
import { readBlob } from "./blobs";
import { reportedActiveSceneId } from "./frame-events";
import {
  assignScenesToFrame,
  currentSceneAssignments,
  maxScenesPerFrame,
  type RequestedScene,
} from "./frame-scenes";
import { buildScenesPayloadForFrame } from "./frames";
import { logInfo, reportError } from "./log";
import { declaredSceneGrants, grantsWidenedBy } from "./panel-code-grants";
import { panelSceneChangesAllowed, type PanelSceneOutcome } from "./panel-scenes";
import { hasPhotoShareLink } from "./photos/share-links-in-scenes";
import { checkIdentityRateLimit } from "./rate-limit";
import { extractScenesFromZip } from "./scene-title";
import { compiledSceneNames, maxSceneEditsPerHour, maxSceneZipBytes, rebuildZip, validateSceneZip } from "./store";
import { imageSetForVersion } from "./store-images";
import { photoLinkErrorCode } from "./store-photo-links";
import { alignZipCover, nextSceneVersion, writeSceneVersion } from "./store-version-write";
import { accountLimits, privateSceneBytesForAccount } from "./usage";

// What the code editor on a frame asks of the cloud (docs/code-editor.md
// "The plane: POST /api/frames/{id}/panel/code"), with the frame's own
// enrollment token, as panel-scenes.ts is for the Scene store:
//
// - `ask`: the scene AI builds or changes one scene from a request typed on
//   the frame's screen. It is the voice chat's sub-turn (voice-scene-builder.ts,
//   asked "typed"): the editor and catalog tools alone, never the MCP tools,
//   the frame in context, the scene rendered in the frame's memory. Nothing
//   is saved: the answer is a draft the device keeps until it saves it.
// - `save`: one scene goes on the frame's list, the way the workspace saves a
//   frame's scene ("Save & push", cloudFrameScenesSave.ts). On the cloud a
//   frame's scenes are store scenes assigned to it, so a scene of an id the
//   frame holds becomes a new version of the store scene it came from when
//   it is the account's own private scene (a pin follows the edit, an
//   unpinned assignment moves to it), or a new private scene of the account
//   in the assignment's place when it is a public one (the workspace's fork
//   of someone else's scene; the account's own public listing too, which a
//   frame's token never publishes to) — keeping the assignment's grant, button maps and
//   layout either way. A new id becomes a new private scene, added last and
//   granted nothing. Then the list is pushed, showing the scene unless
//   `show: false`.
//
// What a frame may do is narrower than what its owner may: nothing while the
// settings on the screen are off (panel_locked); never a save that widens
// what the scene may do (needs_owner, panel-code-grants.ts); no service key
// granted to a new scene.
//
// The backend's twin is backend/app/api/panel_code.py.

type Database = ReturnType<typeof createDb>;
type FrameRow = typeof frames.$inferSelect;

export const panelCodeActions = ["ask", "save"] as const;
export type PanelCodeAction = (typeof panelCodeActions)[number];

export const maxPanelCodePromptChars = 2000;
export const maxPanelCodeBodyBytes = 1024 * 1024;
const maxSceneIdChars = 128;
// The product surface an ask is metered under.
export const panelCodeAiSurface = "code_editor";

export type PanelCodeBuild = typeof buildSceneByVoice;

function refused(error: string, status: number, detail: Record<string, unknown> = {}): PanelSceneOutcome {
  return { body: { error, ok: false, ...detail }, status };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The scene without the install's bookkeeping (cloudFrameScenesSave.ts
 * `withoutSceneOrigin`): where it came from, its button map and its layout
 * are the assignment's, never scene content. */
export function withoutInstallBookkeeping(scene: JsonObject): JsonObject {
  const { origin: _origin, eventMap: _eventMap, layout: _layout, ...rest } = scene;
  return rest;
}

/** Why `scene` cannot be saved from the frame, null when it can. */
export function panelCodeSceneProblem(scene: unknown): PanelSceneOutcome | null {
  if (!isObject(scene) || typeof scene.id !== "string" || !scene.id || scene.id.length > maxSceneIdChars) {
    return refused("invalid_scene", 400);
  }
  if (scene.id.startsWith("system/")) {
    return refused("invalid_scene", 400, { detail: "a built-in scene" });
  }
  const execution = isObject(scene.settings) ? scene.settings.execution : undefined;
  if ((execution !== undefined && execution !== "interpreted") || compiledSceneNames([scene]).length > 0) {
    return refused("scene_requires_compilation", 400);
  }
  if (isBrokenLayout(scene)) {
    return refused("invalid_layout", 400, { detail: sceneLayoutProblem(scene) });
  }
  return null;
}

export async function runPanelCodeAction(
  db: Database,
  frame: FrameRow,
  body: Record<string, unknown>,
  options: { buildScene?: PanelCodeBuild } = {},
): Promise<PanelSceneOutcome> {
  if (frame.status !== "active") {
    return refused("frame_not_active", 409);
  }
  if (!panelSceneChangesAllowed(frame)) {
    return refused("panel_locked", 403);
  }
  if (body.action === "ask") {
    return askPanelCode(db, frame, body, options.buildScene ?? buildSceneByVoice);
  }
  if (body.action === "save") {
    return savePanelCode(db, frame, body);
  }
  return refused("invalid_action", 400);
}

async function askPanelCode(
  db: Database,
  frame: FrameRow,
  body: Record<string, unknown>,
  build: PanelCodeBuild,
): Promise<PanelSceneOutcome> {
  // At most 2,000 characters reach the model (the backend's twin cuts it
  // the same way); the frame's box holds no more.
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, maxPanelCodePromptChars) : "";
  if (!prompt) {
    return refused("empty_prompt", 400);
  }
  if (body.scene !== undefined && body.scene !== null && (!isObject(body.scene) || typeof body.scene.id !== "string")) {
    return refused("invalid_scene", 400);
  }
  const base = isObject(body.scene) ? withoutInstallBookkeeping(body.scene) : null;
  const accountId = frame.accountId;
  // The voice chat's door: the account's AI switch, its key or ours, the
  // daily cap (api-key.ts).
  const access = await resolveAiAccess(db, accountId, {
    inFlightMicros: inFlightSpendMicros(accountId),
    surface: panelCodeAiSurface,
  });
  if (!access.ok) {
    return refused("ai_unavailable", 503, { detail: access.refusal.detail });
  }
  const { credentials } = access;
  const context = await frameContextBlock(db, accountId, frame.id);
  const turnId = `code-${frame.id}-${Date.now()}`;
  logInfo("frames.panel_code_ask", { base: base ? String(base.name ?? base.id) : null, frameId: frame.id });
  let built: Awaited<ReturnType<PanelCodeBuild>>;
  try {
    built = await build({
      accountId,
      apiKey: credentials.apiKey,
      asked: "typed",
      base,
      db,
      frameBlock: context.block,
      frameId: frame.id,
      model: credentials.model,
      name: null,
      onUsage: (result) => {
        meterAiUsageInBackground({
          accountId,
          chatId: null,
          credentialSource: credentials.source,
          model: credentials.model,
          rounds: result.rounds,
          surface: panelCodeAiSurface,
          turnId: `${turnId}-${result.rounds}`,
          usage: result.usage,
        });
      },
      reasoningEffort: credentials.reasoningEffort,
      renderDevice: context.renderDevice ?? null,
      renderScale: context.renderScale ?? null,
      renderSize: context.resolution ?? null,
      request: prompt,
    });
  } catch (error) {
    reportError("frames.panel_code_ask_failed", error, { accountId, frameId: frame.id });
    const detail = error instanceof OpenAiRequestError ? error.message : String(error);
    return refused("ai_failed", 502, { detail: detail.slice(0, 500) });
  }
  if (!built.ok) {
    // 200 on purpose, as the voice route: the frame reads the code.
    return refused(built.error, 200, { detail: (built.detail ?? "").slice(0, 500) });
  }
  // A change stays the scene it changes: the save replaces it by its id.
  const scene = base ? { ...built.scene, id: base.id } : built.scene;
  return { body: { ok: true, scene, summary: built.summary ?? "" }, status: 200 };
}

// The scenes.json of one store version, as stored (no origin stamp).
async function storeVersionScenes(db: Database, sceneId: string, version: number | null) {
  const [row] = await db
    .select({ content: storeSceneVersions.content, objectKey: storeSceneVersions.objectKey })
    .from(storeSceneVersions)
    .where(
      and(
        eq(storeSceneVersions.sceneId, sceneId),
        isNull(storeSceneVersions.yankedAt),
        ...(version === null ? [] : [eq(storeSceneVersions.version, version)]),
      ),
    )
    .orderBy(desc(storeSceneVersions.version))
    .limit(1);
  const content = await readBlob(row);
  return content ? { scenes: extractScenesFromZip(content), zip: content } : undefined;
}

type StoreSceneRow = typeof storeScenes.$inferSelect;

/**
 * A new version of the account's own store scene with `scenes` as its
 * scenes.json: the editor's Save (app/api/account/scenes/[sceneId]/content)
 * with the listing, the images and the name kept as they are. The same
 * zip validation, photo-link rule, byte quota and per-account edit budget.
 */
async function appendSceneVersion(
  db: Database,
  frame: FrameRow,
  scene: StoreSceneRow,
  scenes: unknown[],
): Promise<{ version: number } | PanelSceneOutcome> {
  const accountId = frame.accountId;
  if (scene.status !== "active") {
    return refused("scene_pulled", 403);
  }
  const edits = await checkIdentityRateLimit(accountId, "store:scene-edit", {
    limit: maxSceneEditsPerHour,
    windowMs: 60 * 60 * 1000,
  });
  if (!edits.allowed) {
    return refused("rate_limited", 429);
  }
  const photoLink = hasPhotoShareLink(scenes);
  if (photoLink && scene.visibility === "public") {
    return refused(photoLinkErrorCode, 400);
  }
  const latest = await storeVersionScenes(db, scene.id, null);
  if (!latest) {
    return refused("version_not_found", 409);
  }
  // The frame was sent each scene without its apps' tests: they stay.
  const kept = scenes.map((entry) => {
    const id = (entry as { id?: unknown }).id;
    return keepAppTestFiles(entry, (latest.scenes ?? []).find((old) => (old as { id?: unknown }).id === id));
  });
  const rebuilt = rebuildZip(latest.zip, { scenesJson: JSON.stringify(kept, null, 2) });
  if (!rebuilt) {
    return refused("invalid_scene_zip", 409);
  }
  if (rebuilt.length > maxSceneZipBytes) {
    return refused("scene_too_large", 413, { max_bytes: maxSceneZipBytes });
  }
  const validation = validateSceneZip(rebuilt);
  if (!validation.ok) {
    return refused(validation.error, 400);
  }
  const images = await imageSetForVersion(db, scene.id, null);
  const aligned = await alignZipCover(rebuilt, validation.value, images);
  if ("error" in aligned) {
    return refused(aligned.error, aligned.error === "scene_too_large" ? 413 : 409);
  }
  if (scene.visibility !== "public") {
    const [privateBytes, { privateSceneBytes: maxBytes }] = await Promise.all([
      privateSceneBytesForAccount(db, accountId),
      accountLimits(db, accountId),
    ]);
    if (privateBytes + aligned.content.length > maxBytes) {
      return refused("storage_quota_exceeded", 403, { max_bytes: maxBytes });
    }
  }
  const version = await nextSceneVersion(db, scene.id);
  const closingShareLink = photoLink && scene.shareToken !== null;
  const written = await writeSceneVersion(db, {
    content: aligned.content,
    images,
    listing: {
      category: scene.category,
      description: scene.description,
      frameosVersion: scene.frameosVersion,
      tags: scene.tags,
    },
    message: null,
    ...(closingShareLink ? { rowChanges: { shareToken: null } } : {}),
    sceneId: scene.id,
    validated: aligned.validated,
    version,
  });
  if ("error" in written) {
    return refused(written.error, 500);
  }
  await recordAuditEvent(db, {
    accountId,
    actor: { accountId, frameId: frame.id, kind: "panel" },
    eventType: "store.scene_content_edited",
    metadata: { name: scene.name, sceneCount: aligned.validated.sceneCount, scenesChanged: true, source: "panel_code", version },
    target: { sceneId: scene.id },
  });
  return { version };
}

async function savePanelCode(db: Database, frame: FrameRow, body: Record<string, unknown>): Promise<PanelSceneOutcome> {
  const problem = panelCodeSceneProblem(body.scene);
  if (problem) {
    return problem;
  }
  const show = body.show !== false;
  const accountId = frame.accountId;
  const actor = { accountId, frameId: frame.id, kind: "panel" };
  const asked = withoutInstallBookkeeping(body.scene as JsonObject);
  const sceneId = asked.id as string;

  // The frame's scenes as a push carries them: each stamped with the store
  // scene and version it came from.
  const built = await buildScenesPayloadForFrame(db, frame.id);
  if ("error" in built) {
    return refused(built.error, 409);
  }
  const held = built.scenes.find((entry): entry is JsonObject => isObject(entry) && entry.id === sceneId) ?? null;

  // The `default` mark is the frame's list's, kept as the saved scene had it.
  const { default: _default, ...rest } = asked;
  const scene: JsonObject = held?.default === true ? { ...rest, default: true } : rest;

  const needs = grantsWidenedBy(held ? declaredSceneGrants(held) : null, declaredSceneGrants(scene));
  if (needs.length > 0) {
    return refused("needs_owner", 403, { needs });
  }

  const existing = await currentSceneAssignments(db, frame.id);
  let requested: RequestedScene[];
  let storeSceneId: string;
  let version: number | undefined;
  if (held) {
    const origin = isObject(held.origin) ? held.origin : {};
    const ownerId = typeof origin.storeSceneId === "string" ? origin.storeSceneId : "";
    const heldVersion = Number.parseInt(String(origin.version ?? ""), 10);
    const assignment = existing.find((entry) => entry.sceneId.toLowerCase() === ownerId.toLowerCase());
    const [storeScene] = ownerId
      ? await db.select().from(storeScenes).where(eq(storeScenes.id, ownerId)).limit(1)
      : [];
    if (!assignment || !storeScene) {
      return refused("scene_not_assigned", 409);
    }
    // The pack as the frame holds it, with this scene replaced: a pack's
    // other scenes stay as they are.
    const pack = await storeVersionScenes(db, storeScene.id, Number.isInteger(heldVersion) ? heldVersion : null);
    if (!pack?.scenes) {
      return refused("scene_version_missing", 409);
    }
    const scenes = pack.scenes.map((entry) => (isObject(entry) && entry.id === sceneId ? scene : entry));
    // Only the account's own PRIVATE scene takes a version from a frame: a
    // public one is the store's, and a frame's token never publishes to it.
    if (storeScene.accountId === accountId && storeScene.visibility === "private") {
      const appended = await appendSceneVersion(db, frame, storeScene, scenes);
      if ("body" in appended) {
        return appended;
      }
      version = appended.version;
      storeSceneId = storeScene.id;
      requested = existing.map((entry) =>
        entry === assignment
          ? { ...entry, latest: true, sceneVersion: entry.sceneVersion === null ? null : appended.version }
          : entry,
      );
    } else {
      // A public scene (someone else's, or the account's own listing): the
      // edit becomes the account's own private copy in the assignment's place, with its grant (narrowed to
      // what the copy declares when assigned), button maps and layout.
      const created = await createFrameScene(db, frame, storeScene.name, scenes);
      if ("body" in created) {
        return created;
      }
      ({ sceneId: storeSceneId, version } = created);
      requested = existing.map((entry) =>
        entry === assignment
          ? {
              eventMaps: entry.eventMaps ?? undefined,
              latest: true,
              layouts: entry.layouts ?? undefined,
              sceneId: created.sceneId,
              sceneVersion: null,
              settingsGroups: entry.settingsGroups ?? [],
            }
          : entry,
      );
    }
  } else {
    if (existing.length >= maxScenesPerFrame) {
      return refused("too_many_scenes", 409, { max: maxScenesPerFrame });
    }
    const name = typeof scene.name === "string" && scene.name.trim() ? scene.name.trim() : "Untitled scene";
    const created = await createFrameScene(db, frame, name, [scene]);
    if ("body" in created) {
      return created;
    }
    ({ sceneId: storeSceneId, version } = created);
    // Nothing granted: what a device asks must never widen a grant.
    requested = [...existing, { latest: true, sceneId: created.sceneId, sceneVersion: null, settingsGroups: [] }];
  }

  const outcome = await assignScenesToFrame(db, {
    accountId,
    activeSceneId: show ? sceneId : reportedActiveSceneId(frame.lastState),
    actor,
    frame,
    requested,
    via: "panel",
  });
  if (!outcome.ok) {
    return refused(outcome.failure.code, outcome.failure.status, outcome.failure.detail);
  }
  return {
    body: {
      command_id: outcome.result.commandId,
      ok: true,
      scene_id: sceneId,
      status: "queued",
      store_scene_id: storeSceneId,
      version: outcome.result.sceneVersions[storeSceneId] ?? version,
    },
    status: 200,
  };
}

// A new private scene of the account, through the one publish path
// (account-scene-create.ts: validation, moderation, quotas, audit), the
// frame's linked client publishing: a frame's token is not the owner's.
async function createFrameScene(
  db: Database,
  frame: FrameRow,
  name: string,
  scenes: unknown[],
): Promise<{ sceneId: string; version: number } | PanelSceneOutcome> {
  const response = await createAccountScene(db, {
    accountId: frame.accountId,
    actor: { linkedClientId: frame.linkedClientId },
    name,
    scenes,
  });
  const created = (await response.json().catch(() => ({}))) as {
    error?: string;
    scene?: { id?: string; version?: number };
  };
  if (!response.ok || typeof created.scene?.id !== "string") {
    return refused(created.error ?? "save_failed", response.ok ? 500 : response.status);
  }
  return { sceneId: created.scene.id, version: created.scene.version ?? 1 };
}
