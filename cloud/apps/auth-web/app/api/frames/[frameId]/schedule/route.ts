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
  maxScheduleUtcOffsetMinutes,
  minScheduleUtcOffsetMinutes,
  scheduleDevicePayload,
  supersedePendingCommands,
  validateFrameSchedule,
} from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// Declarative scene-schedule push (docs/cloud-frames.md `set_schedule`).
// The full schedule — disabled events and all — is provider-side state
// (frames.schedule, what frameSummary returns, so the SPA's Schedule panel
// round-trips its edits); the device receives the resolved subset it should
// actually fire. Like set_scenes and unlike render/reboot, the command gets
// no TTL: a schedule is declarative state, and a battery frame that connects
// tomorrow should still receive today's schedule.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:schedule", {
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
  const validated = validateFrameSchedule(body.schedule);
  if (validated.error || !validated.schedule) {
    return jsonError(validated.error ?? "invalid_schedule", 400);
  }
  const schedule = validated.schedule;

  // Schedules match in frame-local wall-clock time, but the smallest device
  // (ESP32) carries no tz database — the backend serves it a current
  // `utcOffsetMinutes` next to the schedule (embedded_device.py), and the
  // fos_schedule.h contract names the cloud as the other legitimate source.
  // The SPA sends the browser's current offset; it rides the same command so
  // firmware can pick it up from the verb (today's firmware still takes it
  // from the backend settings poll and ignores unknown message keys, so
  // carrying it is forward-compatible, never harmful).
  const utcOffsetMinutes = body.utcOffsetMinutes;
  if (
    utcOffsetMinutes !== undefined &&
    (!Number.isInteger(utcOffsetMinutes) ||
      (utcOffsetMinutes as number) < minScheduleUtcOffsetMinutes ||
      (utcOffsetMinutes as number) > maxScheduleUtcOffsetMinutes)
  ) {
    return jsonError("invalid_utc_offset", 400);
  }

  await db
    .update(frames)
    .set({ schedule, updatedAt: new Date() })
    .where(eq(frames.id, frame.id));

  // The hub flattens the payload into the wire message
  // (apps/frame-hub/src/protocol.ts commandMessage), so the device sees
  // {"schedule": {...}, "utcOffsetMinutes"?: N, "id", "type": "set_schedule"}
  // — the shape both the Nim handler (hub_client.nim handleSetSchedule) and
  // the ESP32 handler (fos_cloud.c) read.
  await supersedePendingCommands(db, frame.id, "set_schedule");
  const command = await enqueueFrameCommand(db, {
    createdByAccountId: session.accountId,
    frameId: frame.id,
    payload: {
      schedule: scheduleDevicePayload(schedule),
      ...(utcOffsetMinutes === undefined ? {} : { utcOffsetMinutes }),
    },
    type: "set_schedule",
  });

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: {
      accountId: session.accountId,
      providerSubject: session.providerSubject,
    },
    eventType: "frame.schedule_pushed",
    metadata: {
      disabled: schedule.disabled === true,
      events: schedule.events.length,
    },
    target: { commandId: command?.id, frameId: frame.id },
  });

  return NextResponse.json({
    command_id: command?.id ?? null,
    status: "queued",
  });
}
