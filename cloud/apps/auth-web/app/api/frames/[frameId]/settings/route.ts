import { eq } from "drizzle-orm";
import { frames } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import {
  enqueueFrameCommand,
  frameForAccount,
  supersedePendingCommands,
  validateFrameSettings,
} from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// Declarative settings push. The allowlist is enforced here AND on the
// device — the control plane refusing early is UX; the device refusing is
// the security boundary.
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
  const validated = validateFrameSettings(body.settings);
  if (validated.error || !validated.settings) {
    return jsonError(validated.error ?? "invalid_settings", 400);
  }
  const settings = validated.settings;

  // The frame's NAME is provider-side data (frames.name, what frameSummary
  // returns) — the device never has to accept it. The ESP32 firmware answers
  // `unsupported_verb` for set_settings, so for esp32 platforms the name is
  // the ONLY settable key and nothing is enqueued; refuse mixed payloads up
  // front so nothing is half-applied.
  const platform = (frame.hardware as { platform?: unknown } | null)?.platform;
  const isEsp32 =
    typeof platform === "string" &&
    platform.toLowerCase().startsWith("esp32");
  if (isEsp32 && Object.keys(settings).some((key) => key !== "name")) {
    return jsonError("settings_not_supported_by_device", 400);
  }

  if (typeof settings.name === "string") {
    await db
      .update(frames)
      .set({ name: settings.name, updatedAt: new Date() })
      .where(eq(frames.id, frame.id));
  }

  // Non-esp32 devices still get the push (name included) so their local
  // config stays in sync with what the cloud now shows.
  let command: Awaited<ReturnType<typeof enqueueFrameCommand>> | undefined;
  if (!isEsp32) {
    await supersedePendingCommands(db, frame.id, "set_settings");
    command = await enqueueFrameCommand(db, {
      createdByAccountId: session.accountId,
      frameId: frame.id,
      payload: { settings },
      type: "set_settings",
    });
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.settings_pushed",
    metadata: { keys: Object.keys(settings) },
    target: { commandId: command?.id, frameId: frame.id },
  });

  return NextResponse.json({
    command_id: command?.id ?? null,
    status: command ? "queued" : "applied",
  });
}
