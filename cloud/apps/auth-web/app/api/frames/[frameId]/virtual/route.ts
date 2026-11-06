import { eq } from "drizzle-orm";
import { frames, virtualFrames } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { jsonError, readJsonObject, requireDatabase } from "../../../../../src/lib/device-flow";
import { getCloudBaseUrl } from "../../../../../src/lib/env";
import { frameForAccount } from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";
import { virtualFrameDetails } from "../../../../../src/lib/virtual-frame-view";
import {
  newVirtualViewToken,
  notifyVirtualFrame,
  virtualFrameRow,
  virtualFrameSize,
  virtualHardware,
  virtualSizeError,
} from "../../../../../src/lib/virtual-frames";

export const runtime = "nodejs";

// A virtual frame's own settings (docs/cloud-frames.md "Virtual frames"):
// what hardware has in its panel and nothing else has at all.
//
//   GET  /api/frames/{id}/virtual
//   -> 200 {"virtual": {view_url, image_url, width, height, rendered_at,
//           render_error, interval_seconds, min_interval_seconds, …}}
//   -> 404 not_virtual for a frame with hardware behind it
//
//   POST /api/frames/{id}/virtual {"width"?, "height"?, "reset_link"?: true}
//   -> 200 {"virtual": {…}} — a new size is drawn at once; `reset_link`
//      replaces the view link's secret, and every copy of the old link stops
//      working with that request.
async function ownedVirtualFrame(frameId: string) {
  const refused = (response: NextResponse) => ({ ok: false as const, response });
  const session = await readSession();
  if (!session?.accountId) {
    return refused(jsonError("login_required", 401));
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return refused(response);
  }
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return refused(jsonError("invalid_frame", 404));
  }
  const virtual = await virtualFrameRow(db, frame.id);
  if (!virtual) {
    return refused(jsonError("not_virtual", 404));
  }
  return {
    accountId: session.accountId,
    db,
    frame,
    ok: true as const,
    providerSubject: session.providerSubject,
    virtual,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:detail", {
    limit: 240,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const { frameId } = await params;
  const owned = await ownedVirtualFrame(frameId);
  if (!owned.ok) {
    return owned.response;
  }
  return NextResponse.json(
    { virtual: virtualFrameDetails(owned.frame, owned.virtual, getCloudBaseUrl()) },
    // The answer holds the view link.
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:settings", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const { frameId } = await params;
  const owned = await ownedVirtualFrame(frameId);
  if (!owned.ok) {
    return owned.response;
  }
  const { accountId, db } = owned;
  let { frame, virtual } = owned;
  if (frame.status !== "active") {
    return jsonError("frame_not_active", 409);
  }

  const body = await readJsonObject(request);
  if (Object.keys(body).some((key) => !["height", "reset_link", "width"].includes(key))) {
    return jsonError("unsupported_field", 400);
  }
  if (body.reset_link !== undefined && typeof body.reset_link !== "boolean") {
    return jsonError("invalid_reset_link", 400);
  }
  const current = virtualFrameSize(frame.hardware);
  const width = body.width === undefined ? current.width : body.width;
  const height = body.height === undefined ? current.height : body.height;
  const sizeError = virtualSizeError(width, height);
  if (sizeError) {
    return jsonError(sizeError, 400);
  }
  const actor = { accountId, providerSubject: owned.providerSubject };

  if (width !== current.width || height !== current.height) {
    const [updated] = await db
      .update(frames)
      .set({ hardware: virtualHardware(width as number, height as number), updatedAt: new Date() })
      .where(eq(frames.id, frame.id))
      .returning();
    frame = updated ?? frame;
    // No command says "your panel changed": the device hears it here and
    // draws at the new size.
    await notifyVirtualFrame(db, frame.id);
    await recordAuditEvent(db, {
      accountId,
      actor,
      eventType: "frame.virtual_changed",
      metadata: { from: current, to: { height, width } },
      target: { frameId: frame.id },
    });
  }

  if (body.reset_link === true) {
    const [updated] = await db
      .update(virtualFrames)
      .set({ updatedAt: new Date(), viewToken: newVirtualViewToken() })
      .where(eq(virtualFrames.frameId, frame.id))
      .returning();
    virtual = updated ?? virtual;
    // The event and never the link, old or new.
    await recordAuditEvent(db, {
      accountId,
      actor,
      eventType: "frame.virtual_link_reset",
      target: { frameId: frame.id },
    });
  }

  return NextResponse.json(
    { virtual: virtualFrameDetails(frame, virtual, getCloudBaseUrl()) },
    { headers: { "cache-control": "no-store" } },
  );
}
