import { NextRequest, NextResponse } from "next/server";
import { csrfResponse } from "../../../../../src/lib/csrf";
import { createPreviewProxyToken } from "../../../../../src/lib/preview-proxy-token";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { storeRoute } from "../../../../../src/lib/store-cache";

export const runtime = "nodejs";

// Mints the short-lived token a preview worker sends to the proxy next door
// (src/lib/preview-proxy-token.ts). Same-origin only: the page asks and
// hands the token to its worker, which may live where the Origin check
// cannot follow it. A preview asks once when it starts and again every few
// minutes while it stays open, so the limit is loose for a person and tight
// for a script farming tokens. A refused mint costs nothing: the worker
// falls back to the same-origin check, which still works on this origin.
async function handlePost(request: NextRequest) {
  const limited = await rateLimitResponse(request, "store:preview-proxy-token", {
    limit: 120,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  return NextResponse.json(await createPreviewProxyToken());
}

export const POST = storeRoute(handlePost);
