// Last line of defence before anything leaves the browser for PostHog.
//
// Analytics runs on every auth-web route (PostHogProvider is mounted in the
// root layout), and several of those routes carry a capability in the query
// string: /verify-email?token=…, /recovery?token=…, /s/<slug>?share=… and
// /device?user_code=…. Pageview capture sends $current_url verbatim, so
// without this those one-time links and the long-lived scene share token
// would be stored in a third-party analytics product, readable by anyone
// with access to the project.
//
// Two mechanisms cover that, and they overlap on purpose:
//
//   1. `custom_personal_data_properties` (see PostHogProvider) hands
//      SENSITIVE_QUERY_PARAMS to posthog-js itself, which masks them in the
//      URL properties it builds natively ($current_url, $referrer, campaign
//      and person info).
//   2. `redactAnalyticsProperties` re-walks the finished property bag from a
//      `before_send` hook. posthog-js only masks the properties it knows are
//      URLs; autocapture also ships `$elements_chain` (one string containing
//      every ancestor's attr__href), per-element attr__src/attr__href, and
//      network-timing entries. Those are plain strings as far as the SDK is
//      concerned, so they need a scan of their own.
//
// The scan is deliberately blunt: it redacts any `key=value` pair whose key
// looks sensitive, anywhere in any string, whether or not the surrounding
// text parses as a URL. Over-redacting an analytics property costs nothing;
// under-redacting leaks a credential.

// Query parameters whose value is itself a capability or an identifier we do
// not want in analytics. Exported so PostHogProvider can hand the same list
// to posthog-js as `custom_personal_data_properties` — one list, both layers.
export const SENSITIVE_QUERY_PARAMS = [
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "code",
  "credential",
  "credentials",
  "email",
  "id_token",
  "invite",
  "key",
  "otp",
  "password",
  "passwd",
  "pin",
  "recovery",
  "refresh_token",
  "secret",
  "session",
  "share",
  "share_token",
  "sig",
  "signature",
  "token",
  "user_code",
];

const sensitiveParamSet = new Set(SENSITIVE_QUERY_PARAMS);

// Catches the compound spellings the exact list cannot enumerate —
// `frame_token`, `backupKey`, `x-signature`, `client_secret`, and whatever
// the next feature invents.
const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|api[_-]?key|apikey|auth|signature|credential|session|share)/i;

export const REDACTED = "[redacted]";

// Bounded on both sides: a key long enough to be a real parameter name, and a
// value short enough that we are not rewriting a base64 image blob. Values
// stop at the delimiters that end a query parameter, so `?token=abc&next=/x`
// redacts only `abc`.
const PARAM_PAIR_PATTERN = /([A-Za-z0-9_.%-]{1,64})=([^&#\s"'<>]{1,4096})/g;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Person properties set by UserIdentifier: the account's own email and name,
// attached to its own profile on purpose so a user is identifiable in
// PostHog at all. Redacting those would defeat `identify` rather than
// protect anyone, so the email scrub skips these subtrees. URL redaction
// still applies inside them.
const PERSON_PROPERTY_KEYS = new Set(["$set", "$set_once"]);

// Property bags are JSON-shaped, so this bound is about pathological input
// (or a cycle someone introduces later), not about real events.
const MAX_DEPTH = 8;

function isSensitiveKey(rawKey: string) {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    // A malformed escape is not a reason to skip the check — fall through
    // with the raw key.
  }
  const normalized = key.toLowerCase();
  return (
    sensitiveParamSet.has(normalized) || SENSITIVE_KEY_PATTERN.test(normalized)
  );
}

/**
 * Redact `key=value` pairs with a sensitive-looking key, anywhere in a
 * string: a bare URL, a `$elements_chain` blob, a referrer, a fetch URL in a
 * network-timing entry.
 */
export function redactSensitiveParams(value: string) {
  return value.replace(PARAM_PAIR_PATTERN, (match, key: string) =>
    isSensitiveKey(key) ? `${key}=${REDACTED}` : match,
  );
}

/** Replace anything email-shaped. Autocapture reads element text, and plenty
 * of our pages render an address in a button or link (the admin users table
 * most of all). The `ph-no-capture` markers on those regions are the primary
 * defence; this catches the page someone adds next year without one. */
export function redactEmails(value: string) {
  return value.replace(EMAIL_PATTERN, REDACTED);
}

function redactString(value: string, allowEmails: boolean) {
  const withoutParams = redactSensitiveParams(value);
  return allowEmails ? withoutParams : redactEmails(withoutParams);
}

function redactValue(value: unknown, allowEmails: boolean, depth: number): unknown {
  if (typeof value === "string") {
    return redactString(value, allowEmails);
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, allowEmails, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactValue(
      entry,
      allowEmails || PERSON_PROPERTY_KEYS.has(key),
      depth + 1,
    );
  }
  return out;
}

/**
 * Redact a finished PostHog property bag. Returns a new object; the input is
 * never mutated, because posthog-js reuses parts of it (person properties,
 * campaign params) across events.
 */
export function redactAnalyticsProperties<T extends Record<string, unknown>>(
  properties: T,
): T {
  return redactValue(properties, false, 0) as T;
}

// Paths that produce no analytics at all — not a pageview, not a click, not
// a web vital, not an exception. Redaction is the rule everywhere else, but
// superadmin tooling reads every account's email, every scene's owner and
// every open report, and the fact that it was looked at is not worth
// measuring. Dropping whole events here rather than relying on the
// `ph-no-capture` markers means it holds for events that have nothing to do
// with the DOM.
export const SUPPRESSED_PATH_PREFIXES = ["/admin"];

function pathnameOf(value: string) {
  try {
    // The base only matters for relative values ($pathname); an absolute URL
    // ignores it.
    return new URL(value, "http://frameos.invalid").pathname;
  } catch {
    return value;
  }
}

/** True when a URL or path sits under a suppressed prefix. */
export function isSuppressedUrl(value: unknown) {
  if (typeof value !== "string" || value === "") {
    return false;
  }
  const pathname = pathnameOf(value);
  return SUPPRESSED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

// Both the event's own URL and where the browser actually is. An event
// usually carries $current_url, but not every one does ($identify, feature
// flag calls), and a $pageleave fired while navigating away from /admin
// still belongs to /admin. Either being under the prefix is enough to drop.
function isSuppressedEvent(properties: Record<string, unknown>) {
  if (
    isSuppressedUrl(properties.$current_url) ||
    isSuppressedUrl(properties.$pathname)
  ) {
    return true;
  }
  return (
    typeof window !== "undefined" &&
    isSuppressedUrl(window.location?.pathname)
  );
}

// Structurally posthog-js's CaptureResult, kept local so the hook stays a
// plain function the tests can call with a two-field object. `before_send`
// is also handed nulls (an earlier hook in the chain may have dropped the
// event), which pass straight through.
type CaptureLike = {
  event: string;
  properties?: Record<string, unknown> | undefined;
};

/**
 * `before_send` hook: drops events from suppressed paths outright, and
 * redacts the properties of everything else. posthog-js also has a
 * `sanitize_properties` option with the same reach, but it is deprecated in
 * posthog-js 1.x and logs an error line on every single capture; `before_send`
 * is the supported spelling of the same idea, and unlike the deprecated hook
 * it can drop an event rather than only rewrite it.
 *
 * Never throws: a failure here must drop the redaction, not the page. If the
 * walk somehow fails we drop the event rather than send an unredacted one.
 */
export function sanitizeAnalyticsEvent<T extends CaptureLike>(
  data: T | null,
): T | null {
  try {
    if (!data?.properties) {
      // No properties to check against, so fall back to where the browser is.
      return typeof window !== "undefined" &&
        isSuppressedUrl(window.location?.pathname)
        ? null
        : data;
    }
    if (isSuppressedEvent(data.properties)) {
      return null;
    }
    return { ...data, properties: redactAnalyticsProperties(data.properties) };
  } catch {
    return null;
  }
}
