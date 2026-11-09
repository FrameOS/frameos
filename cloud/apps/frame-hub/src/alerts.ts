// Something a person should hear about. It goes to PostHog as one event, and
// the workflow listening for that event there posts it to Discord
// (auth-web's posthog-capture.ts says why it hangs off PostHog). Off, silently,
// without NEXT_PUBLIC_POSTHOG_KEY in the hub's environment.
import { capturePostHogEvent } from "../../auth-web/src/lib/posthog-capture";

export const alertEvent = "cloud ops alert";

const distinctId = "frameos-cloud-frame-hub";
// A failure usually repeats on every render: one message says it all.
const minIntervalMs = 15 * 60 * 1000;

const lastSentAt = new Map<string, number>();

/**
 * `summary` is the message people read, so it names no customer or frame.
 * `fields` stay in PostHog, for whoever follows the alert up.
 */
export function raiseAlert(
  kind: string,
  summary: string,
  fields: Record<string, unknown> = {},
  now = Date.now(),
) {
  const last = lastSentAt.get(kind);
  if (last !== undefined && now - last < minIntervalMs) {
    return;
  }
  lastSentAt.set(kind, now);
  void capturePostHogEvent(alertEvent, distinctId, {
    ...fields,
    $lib: "frameos-cloud-frame-hub",
    kind,
    source: "frame-hub",
    summary,
  });
}

export function resetAlertsForTests() {
  lastSentAt.clear();
}
