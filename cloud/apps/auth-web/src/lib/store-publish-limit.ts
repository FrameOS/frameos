import { identityRateLimitResponse } from "./rate-limit";
import { maxNewScenesPerDay, maxPublishesPerHour } from "./store";
import { accountIsSuperadmin } from "./superadmin";

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
