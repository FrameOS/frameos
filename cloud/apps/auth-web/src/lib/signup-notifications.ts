// Fire-and-forget heads-up when a brand new FrameOS Cloud account is created
// (any provider): a server-side PostHog capture (posthog-capture.ts). The
// "new user" Discord message is a PostHog webhook on this event.

import { capturePostHogEvent } from "./posthog-capture";

export type NewCloudUserInput = {
  accountId: string;
  displayName?: string | undefined;
  email?: string | undefined;
  provider: string;
};

export const newCloudUserEvent = "cloud user signed up";

// Never throws; safe to call without awaiting.
export async function notifyNewCloudUser(input: NewCloudUserInput) {
  await capturePostHogEvent(newCloudUserEvent, input.accountId, {
    display_name: input.displayName,
    email: input.email,
    provider: input.provider,
  });
}
