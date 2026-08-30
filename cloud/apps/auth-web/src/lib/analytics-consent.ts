// Consent state for the one thing on this site that needs consent: PostHog
// analytics in the browser.
//
// Under the ePrivacy Directive (as implemented in Belgium) analytics storage
// needs opt-in consent, and under the GDPR that consent must be freely given,
// specific, informed, and as easy to withdraw as to give. So: nothing loads
// before an answer, "Decline" is a button of equal weight next to "Accept",
// and the choice can be changed later from the footer of every page.
//
// Deliberately NOT covered here, because they are strictly necessary and
// consent would be meaningless: the session cookie, the theme cookie, and
// Turnstile's anti-abuse challenge on the signup form.

export type ConsentChoice = "denied" | "granted";

// Whether this deployment has analytics at all. The key is optional —
// .env.example ships it blank and self-hosted installs run without it — and
// posthog-js refuses an empty token anyway (it logs a console error and never
// initializes). So a blank key must switch off everything consent-related:
// no SDK init, no banner, no "Cookie settings" footer entry.
export function analyticsConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim());
}

export const consentCookieName = "frameos_analytics_consent";

// One year. Long enough not to nag, short enough that consent is refreshed
// rather than inherited forever.
export const consentMaxAgeSeconds = 365 * 24 * 60 * 60;

// Both the banner and PostHogProvider are separate client components with no
// common React ancestor that re-renders on this. A window event is the
// smallest thing that keeps them in step without a context provider around
// the whole tree.
export const consentChangeEvent = "frameos:analytics-consent";

export function parseConsent(value: string | undefined): ConsentChoice | undefined {
  return value === "granted" || value === "denied" ? value : undefined;
}

export function readConsentFromDocument(): ConsentChoice | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${consentCookieName}=`));
  return parseConsent(match?.slice(consentCookieName.length + 1));
}

export function writeConsentToDocument(
  choice: ConsentChoice,
  cookieDomain?: string | undefined,
) {
  if (typeof document === "undefined") {
    return;
  }
  // Lax, not None: this cookie is only ever read first-party. No Secure flag
  // on plain http so local development works; production is https-only and
  // gets it from the __Host-less domain cookie plus HSTS.
  const parts = [
    `${consentCookieName}=${choice}`,
    "path=/",
    `max-age=${consentMaxAgeSeconds}`,
    "samesite=lax",
  ];
  if (cookieDomain) {
    parts.push(`domain=.${cookieDomain}`);
  }
  if (window.location.protocol === "https:") {
    parts.push("secure");
  }
  document.cookie = parts.join("; ");
  window.dispatchEvent(new CustomEvent(consentChangeEvent));
}

// Withdrawal: drop the cookie entirely rather than storing "denied". That
// stops capture immediately AND brings the banner back, so withdrawing and
// re-deciding is the same one click as the original choice — which is what
// art. 7(3) GDPR means by "as easy to withdraw as to give".
export function clearConsentInDocument(cookieDomain?: string | undefined) {
  if (typeof document === "undefined") {
    return;
  }
  const parts = [`${consentCookieName}=`, "path=/", "max-age=0", "samesite=lax"];
  if (cookieDomain) {
    parts.push(`domain=.${cookieDomain}`);
  }
  document.cookie = parts.join("; ");
  window.dispatchEvent(new CustomEvent(consentChangeEvent));
}
