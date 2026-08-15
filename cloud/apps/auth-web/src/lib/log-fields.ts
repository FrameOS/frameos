// Shared field sanitizing for the structured logger (log.ts) and the error
// tracker (error-tracking.ts). Split into its own module so error-tracking
// does not import the logger and the logger does not import the tracker —
// they call each other and a cycle would be easy to create by accident.

export type LogFields = Record<string, unknown>;

// Any field whose *key* looks like a credential is redacted, so no future
// call site can leak a token, cookie, or password into the journal or into
// PostHog by passing a convenient-looking object through.
const redactedKeyPattern =
  /token|secret|password|passwd|authorization|cookie|signature|api[_-]?key/i;

export function redactFields(fields: LogFields | undefined): LogFields {
  if (!fields) {
    return {};
  }
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = redactedKeyPattern.test(key) ? "[redacted]" : value;
  }
  return out;
}

export function errorField(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
