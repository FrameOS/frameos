import { NextRequest } from "next/server";
import { virtualStatusResponse } from "../../../../src/lib/virtual-frame-http";

export const runtime = "nodejs";

// A virtual frame's view link (docs/cloud-frames.md "Virtual frames"):
// when the picture last changed, as JSON. No login; the token is the credential.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  return await virtualStatusResponse(request, token);
}
