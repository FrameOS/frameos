import { frames } from "@frameos-cloud/db";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../../src/lib/csrf";
import { jsonError, readJsonObject, requireDatabase } from "../../../../../../src/lib/device-flow";
import { frameForAccount } from "../../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../../src/lib/session";
import { readVoicePermissions, voicePermissionsPatch } from "../../../../../../src/lib/voice-permissions";

export const runtime = "nodejs";

// The OWNER's switches for what the voice chat may do on this frame
// (docs/voice-chat.md "What the voice chat may do"). Body: any of
// {"change_settings": bool, "use_scenes": bool, "create_scenes": bool};
// omitted keys keep their value. Answers the whole set with the defaults
// filled in, the shape GET /api/frames/{id} reports as `voice_permissions`.
//
// Plane-side policy, applied at the next spoken sentence: the voice route
// reads the column when it builds the turn's tools, so nothing is queued to
// the device and nothing waits for it to wake. Sibling of telemetry/enabled
// in its gates (session, owner, CSRF); the self-hosted backend keeps the same
// three switches in the frame's device_config.
export async function POST(request: NextRequest, { params }: { params: Promise<{ frameId: string }> }) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:voice-permissions", {
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
  const { patch, invalid } = voicePermissionsPatch(body);
  if (invalid.length > 0 || Object.keys(patch).length === 0) {
    return jsonError("invalid_voice_permissions", 400);
  }
  const current = readVoicePermissions(frame.voicePermissions);
  const next = { ...current, ...patch };
  const changed = (Object.keys(next) as (keyof typeof next)[]).some((key) => next[key] !== current[key]);
  if (changed) {
    await db
      .update(frames)
      .set({ updatedAt: new Date(), voicePermissions: next })
      .where(eq(frames.id, frame.id));
    await recordAuditEvent(db, {
      accountId: session.accountId,
      actor: { accountId: session.accountId, providerSubject: session.providerSubject },
      eventType: "frame.voice_permissions_changed",
      metadata: { from: current, to: next },
      target: { frameId: frame.id },
    });
  }
  return NextResponse.json({ status: changed ? "updated" : "unchanged", voice_permissions: next });
}
