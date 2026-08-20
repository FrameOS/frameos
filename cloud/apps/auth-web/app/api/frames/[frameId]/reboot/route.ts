import { NextRequest } from "next/server";
import { handleFrameActionCommand } from "../../../../../src/lib/frame-action-route";

export const runtime = "nodejs";

// Canonical reboot: the same POST /api/frames/{id}/reboot the self-hosted
// backend serves, mapped onto the queued `reboot` verb (full host reboot;
// /restart restarts only the FrameOS process).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  return handleFrameActionCommand(request, params, "reboot");
}
