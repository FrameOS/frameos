// The memory of a frame the cloud renders for (docs/server-rendering.md
// "State and events"), as the verbs sent to it write it. The plane is the
// memory, as for a virtual frame: state a scene switch carries and
// setSceneState go into `frame_server_renders` when they are sent, before
// the device hears of them, and a scene event waits there for the render that
// runs it while the device is only asked to pull (`render`).
//
// Its own file, free of frames.ts: enqueueFrameCommand calls it, and the
// render (server-render.ts) needs frames.ts.
import { eq, sql } from "drizzle-orm";
import { frameServerRenders, type createDb } from "@frameos-cloud/db";

type Database = Pick<ReturnType<typeof createDb>, "execute" | "insert" | "select" | "update">;

/** Scene events held for one frame's next render, at most. */
export const maxHeldServerRenderEvents = 32;
/** A verb's state, per scene, at most (JSON bytes): a push carries public fields. */
const maxHeldStateBytes = 64 * 1024;
const maxSceneIdChars = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sceneIdOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxSceneIdChars ? value : undefined;
}

/** The row, made if the frame has none yet. */
async function ensureRow(db: Database, frameId: string): Promise<void> {
  await db.insert(frameServerRenders).values({ frameId }).onConflictDoNothing();
}

async function bump(db: Database, frameId: string, set: Record<string, unknown> = {}): Promise<void> {
  await db
    .update(frameServerRenders)
    .set({
      ...set,
      revision: sql`${frameServerRenders.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(frameServerRenders.frameId, frameId));
}

/** Merge `state` into `pending_states[sceneId]`, raw: the render filters it to the scene's public fields. */
async function holdState(db: Database, frameId: string, sceneId: string, state: Record<string, unknown>) {
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > maxHeldStateBytes) {
    return;
  }
  await bump(db, frameId, {
    pendingStates: sql`jsonb_set(
      ${frameServerRenders.pendingStates},
      array[${sceneId}]::text[],
      coalesce(${frameServerRenders.pendingStates} -> ${sceneId}, '{}'::jsonb) || ${JSON.stringify(state)}::jsonb,
      true
    )`,
  });
}

export type HeldVerb =
  /** Queue the verb as it is. */
  | { type: "as_is" }
  /** Held on the plane; queue `render` in its place, so the device pulls. */
  | { type: "render_instead" }
  /** Refuse it: the plane holds as many events as it takes. */
  | { error: "queue_full"; type: "refused" };

/**
 * What a verb to a frame the cloud renders for does to its memory, before it
 * is queued. Returns how to queue it.
 */
export async function holdServerRenderVerb(
  db: Database,
  frameId: string,
  type: string,
  payload: unknown,
): Promise<HeldVerb> {
  const body = isRecord(payload) ? payload : {};
  if (type === "set_current_scene" || type === "set_scenes") {
    const target = sceneIdOf(body.scene_id);
    if (type === "set_scenes" || target) {
      await ensureRow(db, frameId);
    }
    if (target) {
      // The plane's choice until the device has taken the switch (the pull's
      // "Which scene" rule reads the queue for that).
      await bump(db, frameId, { activeScene: target });
      if (isRecord(body.state) && Object.keys(body.state).length > 0) {
        await holdState(db, frameId, target, body.state);
      }
    } else if (type === "set_scenes") {
      // A new bundle: a kept picture of the old one is no good.
      await bump(db, frameId);
    }
    return { type: "as_is" };
  }
  if (type === "scene_event") {
    const name = typeof body.name === "string" ? body.name : "";
    if (!name) {
      return { type: "as_is" };
    }
    const eventPayload = isRecord(body.payload) ? body.payload : {};
    await ensureRow(db, frameId);
    if (name === "setSceneState" && isRecord(eventPayload.state)) {
      // Kept, so the scene has it at the next render and every later one,
      // under the scene the plane last drew or was told to show.
      const [row] = await db
        .select({ activeScene: frameServerRenders.activeScene })
        .from(frameServerRenders)
        .where(eq(frameServerRenders.frameId, frameId))
        .limit(1);
      const target = sceneIdOf(row?.activeScene);
      if (target) {
        await holdState(db, frameId, target, eventPayload.state);
        return { type: "render_instead" };
      }
    }
    // The runtime decides what the cloud may say to the scene (the event
    // contract's origins) at the render that delivers it.
    const event = { name, origin: "cloud", payload: eventPayload };
    const appended = await db.execute(sql`
      update ${frameServerRenders}
      set pending_events = pending_events || ${JSON.stringify([event])}::jsonb,
          revision = revision + 1,
          updated_at = now()
      where frame_id = ${frameId}
        and jsonb_array_length(pending_events) < ${maxHeldServerRenderEvents}
      returning frame_id
    `);
    return appended.length > 0 ? { type: "render_instead" } : { error: "queue_full", type: "refused" };
  }
  return { type: "as_is" };
}
