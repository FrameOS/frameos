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

import { logWarn, reportError } from "./log";

const verifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const verifyTimeoutMs = 8000;

// One report per process, not one per request: a misconfigured deploy would
// otherwise file an exception on every signup attempt for as long as it runs.
let reportedMissingSiteKey = false;

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

  // The half-configured deploy, which is a real trap rather than a
  // hypothetical: NEXT_PUBLIC_* is inlined at BUILD time, and the production
  // bundle is built on a developer machine and streamed to the server
  // (scripts/deploy.sh). Setting the site key only in the server's env file
  // therefore ships forms that render no widget, while this secret is very
  // much set at runtime — so every signup arrives tokenless and would be
  // rejected here. That is a 100% outage of account creation and password
  // reset, caused by a config mistake no user can see or work around.
  //
  // So fail OPEN in exactly this case, and shout. Turnstile being off until
  // someone rebuilds is bad; nobody being able to sign up or recover an
  // account is worse. This is deliberately NOT the Cloudflare-unreachable
  // case below, which stays closed: only an operator can reach this state,
  // and only a rebuild clears it.
  if (!getTurnstileSiteKey()) {
    if (!reportedMissingSiteKey) {
      reportedMissingSiteKey = true;
      reportError(
        "turnstile.site_key_missing_from_build",
        new Error(
          "TURNSTILE_SECRET_KEY is set but NEXT_PUBLIC_TURNSTILE_SITE_KEY was absent when this bundle was built, so no widget renders and no token can arrive. Turnstile is DISABLED until the app is rebuilt with the site key present. Set it on the machine that runs the build, not only on the server.",
        ),
      );
    }
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
