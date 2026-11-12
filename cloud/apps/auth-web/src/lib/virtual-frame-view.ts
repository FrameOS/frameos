// What the owner is told about a virtual frame, and how the view link
// resolves (docs/cloud-frames.md "Virtual frames"). auth-web only.

import { and, eq, isNull } from "drizzle-orm";
import { frames, linkedClients, virtualFrames, type createDb } from "@frameos-cloud/db";
import { cloudRenderedMinIntervalSeconds } from "./cloud-rendered";
import { readFrameSettings } from "./frames";
import {
  isVirtualViewToken,
  virtualFrameSize,
  virtualFrameViewStampMs,
  virtualImagePath,
  virtualRenderIntervalSeconds,
  virtualViewPath,
} from "./virtual-frames";

type Database = ReturnType<typeof createDb>;

/** How often this frame renders while someone looks, in seconds. */
export function virtualFrameIntervalSeconds(
  frame: Pick<typeof frames.$inferSelect, "settings">,
  virtual: Pick<typeof virtualFrames.$inferSelect, "refreshSeconds">,
): number {
  return virtualRenderIntervalSeconds({
    frameIntervalSeconds: readFrameSettings(frame.settings).interval,
    minIntervalSeconds: cloudRenderedMinIntervalSeconds,
    sceneRefreshSeconds: virtual.refreshSeconds,
  });
}

/** The `virtual` object of GET /api/frames/{id}/virtual. Owner only: it holds the link. */
export function virtualFrameDetails(
  frame: typeof frames.$inferSelect,
  virtual: typeof virtualFrames.$inferSelect,
  origin: string,
) {
  const size = virtualFrameSize(frame.hardware);
  return {
    height: size.height,
    image_url: `${origin}${virtualImagePath(virtual.viewToken)}`,
    // What the frame renders at while someone looks, and the least a plan
    // allows: the Settings panel says both.
    interval_seconds: virtualFrameIntervalSeconds(frame, virtual),
    min_interval_seconds: cloudRenderedMinIntervalSeconds,
    render_error: virtual.renderError,
    render_ms: virtual.renderMs,
    rendered_at: virtual.renderedAt,
    view_url: `${origin}${virtualViewPath(virtual.viewToken)}`,
    viewed_at: virtual.viewedAt,
    width: size.width,
  };
}

/**
 * The frame behind a view link. One answer for every way a link can be dead
 * (never issued, replaced, its frame revoked or deleted): undefined.
 */
export async function virtualFrameForViewToken(db: Database, token: string) {
  if (!isVirtualViewToken(token)) {
    return undefined;
  }
  const [row] = await db
    .select({ frame: frames, virtual: virtualFrames })
    .from(virtualFrames)
    .innerJoin(frames, eq(frames.id, virtualFrames.frameId))
    .innerJoin(linkedClients, eq(linkedClients.id, frames.linkedClientId))
    .where(
      and(
        eq(virtualFrames.viewToken, token),
        eq(frames.status, "active"),
        isNull(linkedClients.revokedAt),
      ),
    )
    .limit(1);
  return row;
}

const lastViewStamp = new Map<string, number>();

/**
 * "Someone is looking at this frame's picture": what keeps it rendering on
 * its interval (the hub's tick reads viewed_at). Throttled in process, then
 * one UPDATE; a failed stamp never fails the view.
 */
export async function markVirtualFrameViewed(db: Database, frameId: string): Promise<void> {
  const now = Date.now();
  if (now - (lastViewStamp.get(frameId) ?? 0) < virtualFrameViewStampMs) {
    return;
  }
  lastViewStamp.set(frameId, now);
  if (lastViewStamp.size > 10_000) {
    lastViewStamp.clear();
  }
  try {
    await db.update(virtualFrames).set({ viewedAt: new Date(now) }).where(eq(virtualFrames.frameId, frameId));
  } catch {
    // presence is an optimisation
  }
}

export function resetVirtualViewStampsForTests() {
  lastViewStamp.clear();
}
