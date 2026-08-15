// Structured single-line JSON logging for auth-web, mirroring
// apps/frame-hub/src/log.ts so both services produce the same shape in the
// journal and one `journalctl -o cat | jq` works across them.
//
// Bare console.error was the previous state of the art here: nineteen call
// sites, each with its own prose format, none machine-readable and none
// reaching an error tracker. `reportError` is the replacement — it writes the
// same structured line AND files the error in PostHog error tracking, so a
// failure that no user ever reports (a Postmark outage silently blocking
// every signup, say) still surfaces somewhere a human looks.

import { captureServerException } from "./error-tracking";
import { errorField, redactFields, type LogFields } from "./log-fields";

export { errorField, type LogFields };

function emit(
  level: "info" | "warn" | "error",
  event: string,
  fields?: LogFields,
) {
  const line = JSON.stringify({
    event,
    level,
    service: "auth-web",
    time: new Date().toISOString(),
    ...redactFields(fields),
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logInfo(event: string, fields?: LogFields) {
  emit("info", event, fields);
}

export function logWarn(event: string, fields?: LogFields) {
  emit("warn", event, fields);
}

export function logError(event: string, fields?: LogFields) {
  emit("error", event, fields);
}

// Log an error AND file it with the error tracker. The PostHog capture is
// fire-and-forget on purpose: request handlers call this on a path that
// already went wrong, and waiting on a third party there would turn a handled
// failure into a slow one. `void` rather than `await` — captureServerException
// never rejects.
export function reportError(
  event: string,
  error: unknown,
  fields?: LogFields & { accountId?: string | undefined },
) {
  emit("error", event, { ...fields, error: errorField(error) });
  void captureServerException({
    distinctId: fields?.accountId,
    error,
    event,
    fields,
  });
}
