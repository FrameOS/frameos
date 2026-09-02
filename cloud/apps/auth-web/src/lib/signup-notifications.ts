// Fire-and-forget heads-up when a brand new FrameOS Cloud account is created
// (any provider): a server-side PostHog capture. Env-gated (unset → skip
// silently, which also keeps integration tests hermetic), has its own
// timeout, and never throws — a broken notification must not break signup.
// Anything downstream (a Discord message, an email) hangs off the PostHog
// event as a webhook there, not off this code.

import { errorField, logWarn } from "./log";

export type NewCloudUserInput = {
  accountId: string;
  displayName?: string | undefined;
  email?: string | undefined;
  provider: string;
};

const notificationTimeoutMs = 5000;

export function buildPostHogCapturePayload(
  input: NewCloudUserInput,
  apiKey: string,
) {
  return {
    api_key: apiKey,
    distinct_id: input.accountId,
    event: "cloud user signed up",
    properties: {
      $lib: "frameos-cloud-auth-web",
      display_name: input.displayName,
      email: input.email,
      provider: input.provider,
    },
  };
}

// Catches its own failures, so this resolves no matter what and is safe to
// call without awaiting.
export async function notifyNewCloudUser(input: NewCloudUserInput) {
  // Same project key and host the browser SDK uses (PostHogProvider.tsx);
  // /capture only needs the public key, so no server-only secret exists.
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  if (!apiKey) {
    return;
  }
  const host = (
    process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://eu.i.posthog.com"
  ).replace(/\/+$/, "");
  try {
    const response = await fetch(`${host}/capture/`, {
      body: JSON.stringify(buildPostHogCapturePayload(input, apiKey)),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(notificationTimeoutMs),
    });
    if (!response.ok) {
      logWarn("signup_notifications.posthog_rejected", {
        status: response.status,
      });
    }
  } catch (error) {
    logWarn("signup_notifications.posthog_failed", {
      error: errorField(error),
    });
  }
}
