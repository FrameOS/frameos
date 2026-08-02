// Structured single-line JSON logging. Field values whose key looks like a
// credential are redacted defensively so no future call site can leak a
// token, cookie, or secret into the journal.
const redactedKeyPattern = /token|secret|password|authorization|cookie|signature/i;

type LogFields = Record<string, unknown>;

function sanitize(fields: LogFields | undefined): LogFields {
  if (!fields) {
    return {};
  }
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = redactedKeyPattern.test(key) ? "[redacted]" : value;
  }
  return out;
}

function emit(level: "info" | "warn" | "error", event: string, fields?: LogFields) {
  const line = JSON.stringify({
    event,
    level,
    time: new Date().toISOString(),
    ...sanitize(fields),
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

export function errorField(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
