// Server-side PostHog capture for operational events (a new signup, a scene
// report). Env-gated on the same public project key the browser SDK uses
// (PostHogProvider.tsx): /capture only needs that key, so no server-only
// secret exists, and with it unset the capture is skipped silently, which
// also keeps integration tests hermetic. Has its own timeout and never
// throws — a broken capture must not break the flow that triggered it.
// Anything downstream (a Discord message, an email) hangs off the PostHog
// event as a webhook destination configured there, not off this code.

import { errorField, logWarn } from "./log";

const captureTimeoutMs = 5000;

export function buildPostHogCapturePayload(
  event: string,
  distinctId: string,
  properties: Record<string, unknown>,
  apiKey: string,
) {
  return {
    api_key: apiKey,
    distinct_id: distinctId,
    event,
    properties: { $lib: "frameos-cloud-auth-web", ...properties },
  };
}

// Resolves no matter what; safe to call without awaiting.
export async function capturePostHogEvent(
  event: string,
  distinctId: string,
  properties: Record<string, unknown>,
) {
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  if (!apiKey) {
    return;
  }
  // `|| default`, not `??`: CI may inline an empty string here.
  const host = (
    process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://eu.i.posthog.com"
  ).replace(/\/+$/, "");
  try {
    const response = await fetch(`${host}/capture/`, {
      body: JSON.stringify(
        buildPostHogCapturePayload(event, distinctId, properties, apiKey),
      ),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(captureTimeoutMs),
    });
    if (!response.ok) {
      logWarn("posthog_capture.rejected", {
        posthog_event: event,
        status: response.status,
      });
    }
  } catch (error) {
    logWarn("posthog_capture.failed", {
      error: errorField(error),
      posthog_event: event,
    });
  }
}
