// Fire-and-forget heads-up when a brand new FrameOS Cloud account is created
// (any provider). Two independent sinks: a Discord message to the reports
// channel and a server-side PostHog capture. Each is env-gated (unset → skip
// silently, which also keeps integration tests hermetic), has its own
// timeout, and never throws — a broken notification must not break signup.

import { errorField, logWarn } from "./log";

export type NewCloudUserInput = {
  accountId: string;
  displayName?: string | undefined;
  email?: string | undefined;
  provider: string;
};

const notificationTimeoutMs = 5000;

// One line, no mention triggers: strip @ so a display name like
// "@everyone" cannot ping the channel or fake a mention (backticks are
// harmless and stay), and collapse whitespace so names cannot inject line
// breaks or Discord block formatting.
export function sanitizeForDiscord(value: string) {
  return value.replace(/@/g, "").replace(/\s+/g, " ").trim();
}

export function formatDiscordSignupMessage(input: NewCloudUserInput) {
  // Display names are free-form text and get sanitized. Emails keep their @:
  // they are normalized single tokens, stripping would mangle them, and the
  // webhook's allowed_mentions:{parse:[]} already makes pinging impossible.
  const displayName = input.displayName
    ? sanitizeForDiscord(input.displayName).slice(0, 120)
    : "";
  const who = displayName || input.email || input.accountId;
  const provider = sanitizeForDiscord(input.provider) || "unknown";
  return `🎉 New FrameOS Cloud user: ${who} (via ${provider})`;
}

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

async function notifyDiscordSignup(input: NewCloudUserInput) {
  const webhookUrl =
    process.env.FRAMEOS_CLOUD_DISCORD_REPORTS_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return;
  }
  try {
    const response = await fetch(webhookUrl, {
      body: JSON.stringify({
        // Belt and braces with sanitizeForDiscord: never ping anyone.
        allowed_mentions: { parse: [] },
        content: formatDiscordSignupMessage(input),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(notificationTimeoutMs),
    });
    if (!response.ok) {
      logWarn("signup_notifications.discord_rejected", {
        status: response.status,
      });
    }
  } catch (error) {
    logWarn("signup_notifications.discord_failed", {
      error: errorField(error),
    });
  }
}

async function capturePostHogSignup(input: NewCloudUserInput) {
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

// Both sinks in parallel; each catches its own failures, so this resolves
// no matter what and is safe to call without awaiting.
export async function notifyNewCloudUser(input: NewCloudUserInput) {
  await Promise.all([notifyDiscordSignup(input), capturePostHogSignup(input)]);
}
