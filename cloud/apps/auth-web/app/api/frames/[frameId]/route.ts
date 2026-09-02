import { eq } from "drizzle-orm";
import { frames } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../src/lib/device-flow";
import {
  allowedFrameSettings,
  enqueueFrameCommand,
  frameForAccount,
  frameHardwareIsEsp32,
  frameSummary,
  linkedClientForFrame,
  revokeFrame,
  supersedePendingCommands,
} from "../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { requireRecentAuth } from "../../../../src/lib/recent-auth";
import { readSession } from "../../../../src/lib/session";

export const runtime = "nodejs";

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
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  // frameForAccount screens the uuid shape itself, so a malformed id lands in
  // the same "invisible, not forbidden" 404 as someone else's frame.
  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  return NextResponse.json({
    frame: {
      ...frameSummary(frame, await linkedClientForFrame(db, frame)),
      last_metrics: frame.lastMetrics,
      last_state: frame.lastState,
    },
  });
}

// Rename a frame through the canonical route — the same POST /api/frames/{id}
// {name} the self-hosted backend accepts, so the shared SPA's renameFrame
// needs no cloud branch (docs/api-triality.md). Only `name` is accepted:
// everything else the backend's update takes (SSH, deploy, mode) has no
// cloud meaning, and full settings saves ride POST /api/frames/{id}/settings
// with its version-gated allowlist. Refusing unknown keys outright beats
// silently dropping them — a caller that sends `interval` here believed it
// was saved.
//
// Semantics mirror a name-only settings push: frames.name is the
// authoritative provider-side display name; devices get a set_settings
// {name} so their local config stays in sync — except ESP32, where a
// name-only payload skips the command (older firmware without the verb
// would refuse the push for nothing).
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
  const session = await readSession();
  if (!session?.accountId) {
    return jsonError("login_required", 401);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  if (frame.status !== "active") {
    return jsonError("frame_not_active", 409);
  }

  const body = await readJsonObject(request);
  if (Object.keys(body).some((key) => key !== "name")) {
    return jsonError("unsupported_field", 400);
  }
  // Same rule the settings allowlist enforces for `name` pushes.
  if (typeof body.name !== "string" || !allowedFrameSettings.get("name")!(body.name)) {
    return jsonError("invalid_name", 400);
  }
  const name = body.name;

  // Saving the name it already has is a no-op, not a device push.
  if (name === frame.name) {
    return NextResponse.json({ command_id: null, status: "applied" });
  }

  await db
    .update(frames)
    .set({ name, updatedAt: new Date() })
    .where(eq(frames.id, frame.id));

  let command: Awaited<ReturnType<typeof enqueueFrameCommand>> | undefined;
  if (!frameHardwareIsEsp32(frame)) {
    await supersedePendingCommands(db, frame.id, "set_settings");
    command = await enqueueFrameCommand(db, {
      createdByAccountId: session.accountId,
      frameId: frame.id,
      payload: { settings: { name } },
      type: "set_settings",
    });
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.renamed",
    metadata: { from: frame.name, to: name },
    target: { commandId: command?.id, frameId: frame.id },
  });

  return NextResponse.json({
    command_id: command?.id ?? null,
    status: command ? "queued" : "applied",
  });
}

// Delete a frame outright — the shape the shared SPA already speaks
// (framesModel.deleteFrame → DELETE /api/frames/{id}). Revoke-then-delete:
// revocation kicks a live socket and invalidates the link token, so the
// device demotes itself to standalone and keeps rendering; the row delete
// then cascades away the frame's commands, logs, asset caches and scene
// assignments (claim tokens keep their history with frame_id set null).
// Unlike revoke, nothing of the frame remains in the workspace afterwards.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:delete", {
    limit: 60,
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

  // Deleting revokes first, and revoking is the sudo-mode action: the same
  // recent-auth window /revoke demands applies here, which also keeps API
  // tokens out (their freshness is never recorded) — a stolen token or an
  // idle cookie must not erase the account's frames.
  const stale = await requireRecentAuth(db, session.accountId);
  if (stale) {
    return stale;
  }

  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }

  // Already-revoked frames just need the row gone; revoking twice is
  // harmless but revokeFrame also NOTIFYs the hub, so skip the noise.
  if (frame.status !== "revoked") {
    await revokeFrame(db, frame);
  }
  await db.delete(frames).where(eq(frames.id, frame.id));
  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.deleted",
    metadata: { name: frame.name },
    target: { frameId: frame.id, linkedClientId: frame.linkedClientId },
  });
  return NextResponse.json({ status: "deleted" });
}
