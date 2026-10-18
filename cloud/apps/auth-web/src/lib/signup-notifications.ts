// Fire-and-forget heads-up when a brand new FrameOS Cloud account is created
// (any provider): a server-side PostHog capture (posthog-capture.ts). The
// "new user" Discord message is a PostHog webhook on this event.
//
// The email address and name go along only when the person accepted
// analytics on the cookie banner (analytics-consent.ts). The privacy page
// lists what PostHog sees, and a signup address is not on that list for
// someone who declined, or who never answered.

import type { ConsentChoice } from "./analytics-consent";
import { capturePostHogEvent } from "./posthog-capture";

export type NewCloudUserInput = {
  accountId: string;
  /** The analytics answer the signup request carried (its consent cookie). */
  analyticsConsent: ConsentChoice | undefined;
  displayName?: string | undefined;
  email?: string | undefined;
  provider: string;
};

export const newCloudUserEvent = "cloud user signed up";

// Never throws; safe to call without awaiting.
export async function notifyNewCloudUser(input: NewCloudUserInput) {
  const identified = input.analyticsConsent === "granted";
  await capturePostHogEvent(newCloudUserEvent, input.accountId, {
    display_name: identified ? input.displayName : undefined,
    email: identified ? input.email : undefined,
    provider: input.provider,
  });
}
