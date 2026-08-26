// Server-side error reporting into PostHog error tracking.
//
// PostHog (rather than Sentry) because it is already the one analytics
// subprocessor this service has — the privacy policy names exactly one, and
// adding a second vendor for stack traces would mean naming two. The browser
// half is posthog-js's own exception autocapture (see PostHogProvider); this
// module is the server half, and both land in the same PostHog project.
//
// Everything here is best-effort: a broken or unreachable error tracker must
// never turn a handled error into an unhandled one, so nothing throws and
// nothing is awaited on a request's critical path.

import { redactFields, type LogFields } from "./log-fields";

const captureTimeoutMs = 5000;

// Distinct id for errors with no user attached. PostHog requires one, and a
// constant keeps every server error under a single "user" instead of
// inventing an identity per crash.
const serverDistinctId = "frameos-cloud-server";

// Shared with the AI telemetry module (ai/telemetry.ts), which posts to the
// same /capture endpoint with the same key.
export function posthogConfig() {
  // Same public project key the browser SDK uses (PostHogProvider.tsx);
  // /capture only needs the public key, so there is no server-only secret.
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }
  const host = (
    process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://eu.i.posthog.com"
  ).replace(/\/+$/, "");
  return { apiKey, host };
}

export function hasErrorTracking() {
  return Boolean(posthogConfig());
}

export function buildExceptionPayload(
  apiKey: string,
  input: {
    distinctId?: string | undefined;
    error: unknown;
    event: string;
    fields?: LogFields | undefined;
  },
) {
  const error = input.error;
  const isError = error instanceof Error;
  return {
    api_key: apiKey,
    distinct_id: input.distinctId?.trim() || serverDistinctId,
    event: "$exception",
    properties: {
      $exception_level: "error",
      // The shape PostHog error tracking groups issues by. Frames are not
      // parsed out of the stack: Next.js server bundles are minified with no
      // source maps uploaded, so per-frame data would be noise. The raw
      // stack string below is the useful artifact.
      $exception_list: [
        {
          mechanism: { handled: true, synthetic: false },
          type: isError ? error.name || "Error" : typeof error,
          value: isError ? error.message : String(error),
        },
      ],
      $lib: "frameos-cloud-auth-web",
      // Our own event name (e.g. "email.send_failed") — the thing to search
      // for when someone reports "signups are silently failing".
      frameos_event: input.event,
      ...redactFields(input.fields),
      ...(isError && error.stack ? { stack: error.stack.slice(0, 8000) } : {}),
    },
  };
}

export async function captureServerException(input: {
  distinctId?: string | undefined;
  error: unknown;
  event: string;
  fields?: LogFields | undefined;
}) {
  const config = posthogConfig();
  if (!config) {
    return;
  }
  try {
    await fetch(`${config.host}/capture/`, {
      body: JSON.stringify(buildExceptionPayload(config.apiKey, input)),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(captureTimeoutMs),
    });
  } catch {
    // Deliberately silent: log.ts has already written the structured line to
    // the journal, which is the durable record. Logging the tracker's own
    // failure here would double every error during a PostHog outage.
  }
}
