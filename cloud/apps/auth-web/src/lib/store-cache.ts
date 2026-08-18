import type { NextRequest } from "next/server";

// next.config.ts stamps `Cache-Control: no-store` on every /api/ response —
// right for a surface where most routes are session-scoped — EXCEPT the
// /api/store/ subtree, so the store's public reads can be edge-cached: the
// immutable `?v=` preview, scenes.json's five minutes, the CDN redirect. A
// static rule cannot tell a public scene from a private one (they share a
// URL shape), so the price of the exemption is that every response from this
// subtree states its own policy — including refusals, rate limits, and the
// private-scene 404s that must never sit at the edge for the next anonymous
// request. This wrapper is that guarantee: whatever a handler did not decide
// is `no-store`. Every route under app/api/store goes through it.

const noStore = "no-store";

export function storeRoute<Args extends [request: NextRequest, ...rest: unknown[]]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    const response = await handler(...args);
    if (!response.headers.has("cache-control")) {
      response.headers.set("cache-control", noStore);
    }
    return response;
  };
}
