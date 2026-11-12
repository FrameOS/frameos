// Sign in with Apple on the web, step two: Apple's form POST (response_mode
// form_post, the only way Apple hands over the person's name). The POST is
// cross-site, so no SameSite=Lax cookie rides it: the flow's state and nonce
// come from the SameSite=None flow cookie the start route set, and the state
// in the form must match it (that match is this route's CSRF check; Apple's
// Origin is never one of ours). The code is exchanged at Apple, the id_token
// verified (Apple's keys, the Services ID as audience, the nonce), and the
// rest is the same as Google's callback (src/lib/provider-callback.ts), with
// 303 redirects so the browser does not post again.
import { appleProviderKey, createDb } from "@frameos-cloud/db";
import { NextRequest, NextResponse } from "next/server";
import {
  appleDisplayNameFromUserField,
  appleFlowCookieName,
  appleFlowCookieOptions,
  exchangeAppleCode,
  readAppleFlowToken,
  sealAppleToken,
  verifyAppleIdToken,
} from "../../../../../src/lib/apple-sign-in";
import {
  getAppleCallbackUrl,
  getAppleSignInConfig,
  getBaseUrl,
} from "../../../../../src/lib/env";
import { logWarn, reportError } from "../../../../../src/lib/log";
import { finishProviderWebSignIn } from "../../../../../src/lib/provider-callback";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

function clearFlowCookie(response: NextResponse) {
  response.cookies.set(appleFlowCookieName, "", { ...appleFlowCookieOptions(), maxAge: 0 });
}

function toLogin(error: string) {
  const response = NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(error)}`, getBaseUrl()),
    303,
  );
  clearFlowCookie(response);
  return response;
}

function field(form: FormData | undefined, name: string) {
  const value = form?.get(name);
  return typeof value === "string" ? value : undefined;
}

export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "auth:apple-callback", {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const form = await request.formData().catch(() => undefined);
  const error = field(form, "error");
  if (error) {
    // Keep Apple's word in the server log only; the login page has copy for
    // a cancel and a generic line for the rest.
    logWarn("auth.apple_provider_error", { detail: error.slice(0, 200) });
    return toLogin(error === "user_cancelled_authorize" ? "apple_cancelled" : "apple_failed");
  }

  const flow = await readAppleFlowToken(request.cookies.get(appleFlowCookieName)?.value);
  const code = field(form, "code");
  if (!flow || !code || field(form, "state") !== flow.state) {
    return toLogin("invalid_state");
  }

  const config = getAppleSignInConfig();
  if (!config?.servicesId) {
    return toLogin("apple_unavailable");
  }

  let claims;
  let refreshToken;
  try {
    const tokens = await exchangeAppleCode(config, {
      clientId: config.servicesId,
      code,
      redirectUri: getAppleCallbackUrl(),
    });
    claims = await verifyAppleIdToken(config, tokens.id_token, {
      audience: config.servicesId,
      nonce: flow.nonce,
    });
    refreshToken = tokens.refresh_token;
  } catch (exchangeError) {
    reportError("auth.apple_code_exchange_failed", exchangeError);
    return toLogin("apple_failed");
  }

  return finishProviderWebSignIn(
    request,
    createDb(),
    {
      claims: {
        email: claims.email,
        email_verified: claims.emailVerified,
        name: appleDisplayNameFromUserField(field(form, "user")),
        sub: claims.sub,
      },
      issuer: config.authUrl,
      providerKey: appleProviderKey,
      providerToken: refreshToken ? sealAppleToken(config.servicesId, refreshToken) : undefined,
      redirectStatus: 303,
      returnTo: flow.returnTo,
    },
    clearFlowCookie,
  );
}
