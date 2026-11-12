import { NextRequest } from "next/server";
import { virtualPageResponse } from "../../../src/lib/virtual-frame-http";

export const runtime = "nodejs";

// A virtual frame's view link (docs/cloud-frames.md "Virtual frames"):
// the page a kiosk browser shows. No login; the token is the credential.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return await virtualPageResponse(request, token);
}
