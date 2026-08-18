import { NextRequest, NextResponse } from "next/server";
import { requireDatabase } from "../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../src/lib/rate-limit";
import {
  listStoreScenes,
  serializeStoreScene,
} from "../../../../src/lib/store-browse";
import {
  parseStoreBrowseFilters,
  parseStorePage,
  storePageSize,
} from "../../../../src/lib/store-filters";
import { storeRoute } from "../../../../src/lib/store-cache";

export const runtime = "nodejs";

// One page of the public store listing, for the lazy feed on the store front
// (src/components/StoreSceneFeed). Same filters and same ordering as the
// server-rendered first page, so scrolling continues the list instead of
// re-shuffling it.
async function handleGet(request: NextRequest) {
  const limited = await rateLimitResponse(request, "store:browse", {
    limit: 600,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const params = request.nextUrl.searchParams;
  const filters = parseStoreBrowseFilters({
    category: params.get("category") ?? undefined,
    q: params.get("q") ?? undefined,
    tag: params.get("tag") ?? undefined,
    version: params.get("version") ?? undefined,
  });
  const page = parseStorePage(params.get("page"));

  const rows = await listStoreScenes(db, filters, page);

  return NextResponse.json(
    {
      // No total here: counting on every scroll step is wasted work. A full
      // page means "there may be more", which is all the feed needs.
      hasMore: rows.length === storePageSize,
      page,
      scenes: rows.map(serializeStoreScene),
    },
    { headers: { "cache-control": "public, max-age=60" } },
  );
}

// Cache policy is per-response here (see storeRoute): anything this
// handler did not decide is no-store.
export const GET = storeRoute(handleGet);
