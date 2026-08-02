import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  parseOptionalString,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import {
  allowedFrameCommandTypes,
  enqueueFrameCommand,
  frameForAccount,
} from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// "Now"-commands expire fast: a reboot queued on Monday must not fire when
// the frame comes back online on Friday.
const commandTtlMs = 5 * 60 * 1000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:command", {
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
  const type = parseOptionalString(body.type) ?? "";
  if (!allowedFrameCommandTypes.has(type)) {
    return jsonError("invalid_command", 400);
  }
  let payload: Record<string, unknown> | undefined;
  if (type === "set_current_scene") {
    const sceneId = parseOptionalString(body.scene_id);
    if (!sceneId || sceneId.length > 256) {
      return jsonError("invalid_command", 400);
    }
    payload = { scene_id: sceneId };
  }

  const command = await enqueueFrameCommand(db, {
    createdByAccountId: session.accountId,
    frameId: frame.id,
    payload,
    ttlMs: commandTtlMs,
    type,
  });

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.command_sent",
    metadata: { type },
    target: { commandId: command?.id, frameId: frame.id },
  });

  return NextResponse.json({ command_id: command?.id, status: "queued" });
}
