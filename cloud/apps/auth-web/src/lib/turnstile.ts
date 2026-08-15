// Cloudflare Turnstile on signup and password reset.
//
// Until now the only gate on either endpoint was the Postgres rate limiter
// (10/hour/IP), which stops one noisy client and nothing else: a botnet, a
// cheap proxy pool, or anyone willing to rotate IPs walks straight through
// it. That is survivable while signups are word-of-mouth and expensive once
// they are not — every fake signup also costs a Postmark send, and enough of
// them cost the sending domain its reputation, which takes the real users'
// verification mail down with it.
//
// Turnstile rather than a captcha the user has to solve: it is free at any
// volume we will see, needs no cookie of its own, and is a privacy-preserving
// challenge (no puzzle, no image labelling) — which also keeps it out of the
// consent banner, since it is strictly necessary for the security of a
// service the user asked for.
//
// Entirely optional: with no keys configured, verification is skipped and the
// forms render without the widget. Local development and the integration
// tests therefore need no Cloudflare account.

import { logWarn } from "./log";

const verifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const verifyTimeoutMs = 8000;

export function getTurnstileSiteKey() {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || undefined;
}

function getTurnstileSecret() {
  return process.env.TURNSTILE_SECRET_KEY?.trim() || undefined;
}

// Both halves have to be present. A site key with no secret would render a
// widget whose answer is never checked — worse than no widget, because it
// looks protected.
export function isTurnstileConfigured() {
  return Boolean(getTurnstileSiteKey() && getTurnstileSecret());
}

export type TurnstileResult =
  | { ok: true }
  | { errorCodes: string[]; ok: false };

export async function verifyTurnstileToken(
  token: string | undefined,
  remoteIp?: string | undefined,
): Promise<TurnstileResult> {
  const secret = getTurnstileSecret();
  if (!secret) {
    return { ok: true };
  }
  if (!token) {
    return { errorCodes: ["missing-input-response"], ok: false };
  }

  const body = new URLSearchParams({ response: token, secret });
  // "local" is rate-limit.ts's placeholder for "no proxy header"; sending it
  // as an IP would make Cloudflare reject the whole verification.
  if (remoteIp && remoteIp !== "local") {
    body.set("remoteip", remoteIp);
  }

  try {
    const response = await fetch(verifyUrl, {
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: AbortSignal.timeout(verifyTimeoutMs),
    });
    if (!response.ok) {
      return { errorCodes: [`http-${response.status}`], ok: false };
    }
    const payload = (await response.json()) as {
      "error-codes"?: string[];
      success?: boolean;
    };
    if (payload.success) {
      return { ok: true };
    }
    return { errorCodes: payload["error-codes"] ?? ["unknown"], ok: false };
  } catch (error) {
    // Fail CLOSED. The alternative — letting signups through whenever
    // Cloudflare is unreachable — turns a Cloudflare outage into an open
    // signup endpoint, which is precisely when a flood is cheapest to run.
    // A brief inability to sign up is the better failure.
    logWarn("turnstile.verification_unavailable", {
      error: error instanceof Error ? error.message : "unknown error",
    });
    return { errorCodes: ["verification-unavailable"], ok: false };
  }
}
