import { NextRequest } from "next/server";
import { handleFrameActionCommand } from "../../../../../src/lib/frame-action-route";

export const runtime = "nodejs";

// Canonical restart: the same POST /api/frames/{id}/restart the self-hosted
// backend serves, mapped onto the queued `restart_runtime` verb (the device
// restarts the FrameOS process, not the host — /reboot does that).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  return handleFrameActionCommand(request, params, "restart_runtime");
}
