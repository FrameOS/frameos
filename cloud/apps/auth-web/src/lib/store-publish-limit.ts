import type { NextRequest } from "next/server";
import { identityRateLimitResponse, rateLimitResponse } from "./rate-limit";
import { maxNewScenesPerDay, maxPublishesPerHour } from "./store";
import { accountIsSuperadmin } from "./superadmin";

// A store write's per-address limit (an upload, a new scene, a version saved,
// an image added), which a superadmin does not have: republishing the whole
// catalog (a new taxonomy on every scene, 2026-11-18) is a hundred uploads in
// a row from one address. Everyone else, signed in or not, keeps it.
export async function storeWriteRateLimitResponse(
  request: NextRequest,
  accountId: string | undefined,
  action: string,
  options: { limit: number; windowMs: number },
) {
  if (await accountIsSuperadmin(accountId)) {
    return undefined;
  }
  return rateLimitResponse(request, action, options);
}

// The account's hourly publish budget (store:publish), which every way of
// publishing a version spends. A superadmin has none: republishing the whole
// catalog at once (a new icon on every scene) would otherwise take hours.
export async function publishRateLimitResponse(accountId: string) {
  if (await accountIsSuperadmin(accountId)) {
    return undefined;
  }
  return identityRateLimitResponse(accountId, "store:publish", {
    limit: maxPublishesPerHour,
    windowMs: 60 * 60 * 1000,
  });
}

// How many new scenes the account may create in 24 hours, or null for no cap.
// Every way of making a new scene (an upload, a linked backend's publish, a
// fork, a frame's scenes imported) asks this. A superadmin has none: a batch
// of new repo samples going to the store is more than any one day allows.
export async function newSceneDailyLimit(
  accountId: string,
): Promise<number | null> {
  if (await accountIsSuperadmin(accountId)) {
    return null;
  }
  return maxNewScenesPerDay;
}
