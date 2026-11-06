import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "../../../../src/lib/audit";
import { csrfResponse } from "../../../../src/lib/csrf";
import { jsonError, parseOptionalString, readJsonObject, requireDatabase } from "../../../../src/lib/device-flow";
import { getCloudBaseUrl } from "../../../../src/lib/env";
import { allowedFrameSettings, frameSummary, isValidTimeZoneName } from "../../../../src/lib/frames";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import { readSession } from "../../../../src/lib/session";
import { createVirtualFrame, VirtualFrameQuotaError } from "../../../../src/lib/virtual-frame-create";
import { virtualFrameDetails } from "../../../../src/lib/virtual-frame-view";
import {
  virtualFrameDefaultHeight,
  virtualFrameDefaultWidth,
  virtualSizeError,
} from "../../../../src/lib/virtual-frames";

export const runtime = "nodejs";

// Create a virtual frame (docs/cloud-frames.md "Virtual frames"): a frame
// with no hardware, rendered by the cloud and shown through a view link.
//
//   POST /api/frames/virtual {"name"?, "width"?, "height"?, "timezone"?}
//   -> 201 {"frame": {…frame summary…}, "virtual": {view_url, image_url, …}}
//   -> 403 cloud_rendered_frame_quota_exceeded {max_cloud_rendered_frames}
//      (the plan's virtual frames are spent; zero on the free plan)
//
// Born active: the signed-in owner is the one making it, so there is nothing
// to confirm. Not a sudo-mode action — it adds a frame the account can
// delete again, and hands out no credential.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "frames:virtual-create", {
    limit: 30,
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

  const body = await readJsonObject(request);
  const name = parseOptionalString(body.name) ?? "Virtual frame";
  if (!allowedFrameSettings.get("name")!(name)) {
    return jsonError("invalid_name", 400);
  }
  const width = body.width === undefined ? virtualFrameDefaultWidth : body.width;
  const height = body.height === undefined ? virtualFrameDefaultHeight : body.height;
  const sizeError = virtualSizeError(width, height);
  if (sizeError) {
    return jsonError(sizeError, 400);
  }
  // The creating browser's zone, as a claim token carries one: dropped, not
  // refused, when it is not a zone.
  const timezoneCandidate = parseOptionalString(body.timezone);
  const timezone = timezoneCandidate && isValidTimeZoneName(timezoneCandidate) ? timezoneCandidate : null;

  let created: Awaited<ReturnType<typeof createVirtualFrame>>;
  try {
    created = await createVirtualFrame(db, {
      accountId: session.accountId,
      height: height as number,
      name,
      timezone,
      width: width as number,
    });
  } catch (error) {
    if (error instanceof VirtualFrameQuotaError) {
      return jsonError(error.code, 403, { max_cloud_rendered_frames: error.limit });
    }
    throw error;
  }

  await recordAuditEvent(db, {
    accountId: session.accountId,
    actor: { accountId: session.accountId, providerSubject: session.providerSubject },
    eventType: "frame.virtual_created",
    metadata: { height, name, width },
    target: { frameId: created.frame.id, linkedClientId: created.linkedClient.id },
  });

  return NextResponse.json(
    {
      frame: {
        ...frameSummary(created.frame, created.linkedClient),
        last_metrics: null,
        last_state: null,
        pending_command_types: [],
        scene_preview: null,
      },
      virtual: virtualFrameDetails(created.frame, created.virtual, getCloudBaseUrl()),
    },
    { status: 201 },
  );
}
