import { eq } from "drizzle-orm";
import { frames } from "@frameos-cloud/db";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { jsonError, requireDatabase } from "../../../../../src/lib/device-flow";
import {
  assignScenesToFrame,
  currentSceneAssignments,
} from "../../../../../src/lib/frame-scenes";
import { frameForAccount, frameSummary } from "../../../../../src/lib/frames";
import { reportError } from "../../../../../src/lib/log";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// Owner confirmation of a claim-token enrollment: pending → active. This is
// the deliberate click that authorizes managing the physical device; no
// scene push is accepted before it.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:confirm", {
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

  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  if (frame.status === "revoked") {
    return jsonError("frame_revoked", 409);
  }
  if (frame.status !== "active") {
    await db
      .update(frames)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(frames.id, frame.id));
    await recordAuditEvent(db, {
      accountId: session.accountId,
      actor: {
        accountId: session.accountId,
        providerSubject: session.providerSubject,
      },
      eventType: "frame.confirmed",
      target: { frameId: frame.id },
    });
    await applyProvisioningScenes(
      db,
      { accountId: session.accountId, providerSubject: session.providerSubject },
      { ...frame, status: "active" },
    );
  }
  return NextResponse.json({
    frame: { ...frameSummary(frame), status: "active" },
    status: "active",
  });
}

/**
 * "Start this frame with the scenes from <that frame>", chosen while building
 * the SD image or flashing the board and carried here on the frame row.
 *
 * Deliberately AT confirmation, not at enrollment: enrollment is
 * unauthenticated (anything holding the claim code can run it), so it must
 * never be the step that decides whose scenes reach a device. By the time
 * this runs the owner has clicked Confirm, the frame is active, and the copy
 * goes through the same assignScenesToFrame gates a workspace deploy does —
 * accessibility, pinned version, shell-risk refusal.
 *
 * Best effort, and the intent is cleared either way: the confirmation itself
 * has already committed, the frame is usable without its scenes, and a copy
 * that retried on every subsequent call would fight the owner's own edits.
 * Failures are reported, never raised.
 */
async function applyProvisioningScenes(
  db: NonNullable<ReturnType<typeof requireDatabase>["db"]>,
  session: { accountId: string; providerSubject?: string },
  frame: typeof frames.$inferSelect,
) {
  const sourceFrameId = frame.sceneSourceFrameId;
  if (!sourceFrameId) {
    return;
  }
  try {
    await db
      .update(frames)
      .set({ sceneSourceFrameId: null })
      .where(eq(frames.id, frame.id));
    // Re-check ownership at use time, not just at mint time: the source frame
    // may have been deleted, or the account may have changed hands, in the
    // days between building the card and booting it.
    const source = await frameForAccount(db, session.accountId, sourceFrameId);
    if (!source || source.id === frame.id) {
      return;
    }
    const requested = await currentSceneAssignments(db, source.id);
    if (requested.length === 0) {
      return;
    }
    const outcome = await assignScenesToFrame(db, {
      accountId: session.accountId,
      actor: {
        accountId: session.accountId,
        providerSubject: session.providerSubject,
      },
      frame,
      requested,
      via: "provisioning",
    });
    if (!outcome.ok) {
      reportError(
        "frames.provisioning_scene_copy_refused",
        new Error(outcome.failure.code),
      );
    }
  } catch (error) {
    reportError("frames.provisioning_scene_copy_failed", error);
  }
}
