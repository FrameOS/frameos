import { identityRateLimitResponse } from "./rate-limit";
import { maxPublishesPerHour } from "./store";
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
