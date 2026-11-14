import { NextRequest, NextResponse } from "next/server";
import { requireDatabase } from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { storeRoute } from "../../../../../src/lib/store-cache";
import {
  listStoreScenesForDevice,
  parseStoreDeviceOptions,
  storeDeviceCategories,
} from "../../../../../src/lib/store-device";
import {
  parseStoreBrowseFilters,
  parseStorePage,
} from "../../../../../src/lib/store-filters";

export const runtime = "nodejs";

// A page of the store for a frame (docs/scene-store.md, the Scene store scene):
// `q`, `category` and `version` (the frame's FrameOS, so it is offered only
// what runs on it) filter as the store front does, `page` counts from 1,
// `limit` is the page's size (its grid, 1 to 24, 12 by default), `prefer` a
// shelf that goes first, `exclude` shelves left out (comma separated), and
// `categories=1` adds the shelves. A dozen scenes is about 3 KB: an ESP32
// parses it beside the scene it is running. Public and cached like the store
// front's own feed, and readable from any page (the browser preview runs the
// scene too); a frame asks with no credential, so it is limited per address
// like any visitor.
async function handleGet(request: NextRequest) {
  const limited = await rateLimitResponse(request, "store:device", {
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
    version: params.get("version") ?? undefined,
  });
  const page = parseStorePage(params.get("page"));
  const options = parseStoreDeviceOptions(params);
  const { more, scenes } = await listStoreScenesForDevice(db, filters, page, options);
  return NextResponse.json(
    {
      page,
      more,
      scenes,
      ...(params.get("categories") === "1" ? { categories: storeDeviceCategories() } : {}),
    },
    { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=60" } },
  );
}

export const GET = storeRoute(handleGet);
