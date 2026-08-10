import { eq } from "drizzle-orm";
import { storeScenes } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext } from "../../../../../src/lib/admin";
import { normalizeCategory } from "../../../../../src/lib/categories";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { sceneSummary } from "../../../../../src/lib/store";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ sceneId: string }> };

// Superadmin moderation: pull (kill switch, with a reason) / restore, and
// feature / unfeature. Every change is written to the audit log against the
// scene owner's account so it shows in their activity feed too.
export async function PATCH(request: NextRequest, context: RouteContext) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }

  const limited = await rateLimitResponse(request, "admin:scenes", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const admin = await getSuperadminContext();
  if (admin.kind !== "ok") {
    return jsonError(
      admin.kind === "forbidden" ? "forbidden" : "unauthenticated",
      admin.kind === "forbidden" ? 403 : 401,
    );
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const { sceneId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(sceneId)) {
    return jsonError("scene_not_found", 404);
  }

  const [scene] = await db
    .select()
    .from(storeScenes)
    .where(eq(storeScenes.id, sceneId))
    .limit(1);
  if (!scene) {
    return jsonError("scene_not_found", 404);
  }

  const body = await readJsonObject(request);
  const events: { eventType: string; metadata: Record<string, unknown> }[] = [];
  const changes: Partial<{
    category: string | null;
    featuredAt: Date | null;
    pulledAt: Date | null;
    pulledReason: string | null;
    status: string;
  }> = {};

  // Superadmins can recategorize any scene — the shelves are store curation,
  // not owner speech, so this needs no owner involvement.
  if (body.category !== undefined) {
    const category = normalizeCategory(body.category);
    if (category === undefined) {
      return jsonError("invalid_category", 400);
    }
    changes.category = category;
    events.push({
      eventType: "store.scene_categorized",
      metadata: { category, name: scene.name },
    });
  }

  if (typeof body.featured === "boolean") {
    if (body.featured && scene.status === "pulled") {
      return jsonError("scene_pulled", 400);
    }
    changes.featuredAt = body.featured ? new Date() : null;
    events.push({
      eventType: body.featured
        ? "store.scene_featured"
        : "store.scene_unfeatured",
      metadata: { name: scene.name },
    });
  }

  const status = parseOptionalString(body.status);
  if (status !== undefined) {
    if (status !== "active" && status !== "pulled") {
      return jsonError("invalid_status", 400);
    }
    changes.status = status;
    if (status === "pulled") {
      const reason =
        parseOptionalString(body.pulled_reason)?.slice(0, 500) ?? null;
      changes.pulledAt = new Date();
      changes.pulledReason = reason;
      // A pulled scene should never stay on the featured shelf.
      changes.featuredAt = null;
      events.push({
        eventType: "store.scene_pulled",
        metadata: { name: scene.name, reason },
      });
    } else {
      changes.pulledAt = null;
      changes.pulledReason = null;
      events.push({
        eventType: "store.scene_restored",
        metadata: { name: scene.name },
      });
    }
  }

  if (Object.keys(changes).length === 0) {
    return jsonError("nothing_to_update", 400);
  }

  const [updated] = await db
    .update(storeScenes)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(storeScenes.id, scene.id))
    .returning();

  if (!updated) {
    return jsonError("scene_update_failed", 500);
  }

  for (const event of events) {
    await recordAuditEvent(db, {
      accountId: scene.accountId,
      actor: { accountId: admin.accountId, role: "superadmin" },
      eventType: event.eventType,
      metadata: event.metadata,
      target: { sceneId: scene.id },
    });
  }

  return NextResponse.json({ scene: sceneSummary(updated), status: "updated" });
}
