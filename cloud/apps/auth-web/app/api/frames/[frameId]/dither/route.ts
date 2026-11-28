import { frames } from "@frameos-cloud/db";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { jsonError, readJsonObject, requireDatabase } from "../../../../../src/lib/device-flow";
import { frameForAccount } from "../../../../../src/lib/frames";
import { ditherProblem } from "../../../../../src/lib/panel-dither";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// How the cloud dithers the picture it packs for this frame's palette panel
// (docs/dithering.md): body {"dither": null | {"method", "algorithm", "dbs",
// "exposure", "viewingDistanceCm"}}; null goes back to Floyd-Steinberg.
// Answers the stored value, the shape GET /api/frames/{id} reports as
// `dither`.
//
// Plane-side, applied at the next render pull: the packer reads the column,
// nothing is queued to the device (it only ever receives the packed picture).
// The self-hosted backend keeps the same object in the frame's `dither`.
// Gates as voice/permissions: session, owner, CSRF.
export async function POST(request: NextRequest, { params }: { params: Promise<{ frameId: string }> }) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:dither", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const { frameId } = await params;
  // Owner-only: frameForAccount is the ownership check.
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }

  const body = await readJsonObject(request);
  if (!body || !("dither" in body)) {
    return jsonError("invalid_dither", 400);
  }
  const next = body.dither ?? null;
  if (ditherProblem(next) !== null) {
    return jsonError("invalid_dither", 400);
  }
  const current = frame.dither ?? null;
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) {
    await db
      .update(frames)
      .set({ dither: next, updatedAt: new Date() })
      .where(eq(frames.id, frame.id));
    await recordAuditEvent(db, {
      accountId: session.accountId,
      actor: { accountId: session.accountId, providerSubject: session.providerSubject },
      eventType: "frame.dither_changed",
      metadata: { from: current, to: next },
      target: { frameId: frame.id },
    });
  }
  return NextResponse.json({ status: changed ? "updated" : "unchanged", dither: next });
}
