import { NextResponse } from "next/server";

export const runtime = "nodejs";

// The SPA's Chat panel also offers per-app code chat; that needs the app's
// full sources and the backend's edit_app tooling, which the cloud does not
// host yet. Answer 501 with a `detail` the SPA surfaces as the chat reply.
export async function POST() {
  return NextResponse.json(
    {
      detail: "App code chat is not available on FrameOS Cloud yet.",
      error: "not_implemented",
    },
    { status: 501 },
  );
}
