import { eq } from "drizzle-orm";
import { frameDeviceScenes } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import {
  dismissDeviceScenes,
  importDeviceScenes,
} from "../../../../../src/lib/device-scene-import";
import { deviceScenesSummary } from "../../../../../src/lib/device-scenes";
import { frameForAccount } from "../../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// The scenes a frame was ALREADY running when it joined the cloud
// (docs/cloud-frames.md, `scenes_get`). The hub asks a frame that reports
// scenes of its own while the cloud has assigned it none, and keeps the
// answer; this is what the workspace's "Import scenes from this frame"
// banner reads and acts on.
//
// GET answers `{device_scenes: null}` when the frame reported nothing, else
// the snapshot's summary — scene names and the verdict, never a scene body.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const limited = await rateLimitResponse(request, "frames:scenes", {
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
  const { frameId } = await params;
  const frame = await frameForAccount(db, session.accountId, frameId);
  if (!frame) {
    return jsonError("invalid_frame", 404);
  }
  const [row] = await db
    .select()
    .from(frameDeviceScenes)
    .where(eq(frameDeviceScenes.frameId, frame.id))
    .limit(1);
  return NextResponse.json({ device_scenes: deviceScenesSummary(row) });
}

// POST {"action": "import"} (the default) mints a private draft store scene
// per reported scene — reusing the ones this account already has, see
// device-scene-import.ts — assigns them to the frame after whatever it
// already has, and pushes the set with the frame's active scene kept on
// screen. Answers the per-scene outcome; `status: "partial"` means a quota
// or an outage refused some and the same call can be repeated later.
// POST {"action": "dismiss"} drops the snapshot and stops the asking. The
// scenes on the device are never touched by either.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  // Each import can mint up to a day's worth of scenes, every one a model
  // call: a far smaller budget than the read above.
  const limited = await rateLimitResponse(request, "frames:device-scenes", {
    limit: 20,
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
  const body = await readJsonObject(request);
  const action = body.action === undefined ? "import" : body.action;
  const actor = {
    accountId: session.accountId,
    providerSubject: session.providerSubject,
  };

  if (action === "dismiss") {
    const dismissed = await dismissDeviceScenes(db, {
      accountId: session.accountId,
      actor,
      frame,
    });
    return dismissed
      ? NextResponse.json({ status: "dismissed" })
      : jsonError("nothing_to_import", 404);
  }
  if (action !== "import") {
    return jsonError("invalid_action", 400);
  }

  const outcome = await importDeviceScenes(db, {
    accountId: session.accountId,
    actor,
    frame,
  });
  if (!outcome.ok) {
    return jsonError(
      outcome.failure.code,
      outcome.failure.status,
      outcome.failure.detail,
    );
  }
  return NextResponse.json({ ...outcome.result, connected: frame.connected });
}
