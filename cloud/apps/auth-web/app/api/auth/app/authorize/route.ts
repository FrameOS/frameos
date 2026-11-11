import { NextRequest, NextResponse } from "next/server";
import {
  appSignInCallbackUrl,
  createAppSignInRequestToken,
  validChallenge,
  validState,
  verifyAppSignInRequestToken,
  type AppSignInRequest,
} from "../../../../../src/lib/app-sign-in";
import { appSignInStep } from "../../../../../src/lib/app-sign-in-grant";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { getPublicOrigin, hasGoogleOAuth } from "../../../../../src/lib/env";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { reauthPath } from "../../../../../src/lib/recent-auth";

export const runtime = "nodejs";

// The app's sign-in sheet opens this (src/lib/app-sign-in.ts):
//
//   GET /api/auth/app/authorize?code_challenge=<S256>&code_challenge_method=S256
//       &state=<app's>[&provider=google][&reauth=1]
//
// It comes back here with ?request=<signed token> after each detour (sign-in,
// Google, sudo mode), and ends in a redirect to frameos://sign-in with a code
// or an error. &cancel=1 (the "Cancel" on /login/app) ends it with
// error=access_denied.
export async function GET(request: NextRequest) {
  const limited = await rateLimitResponse(request, "app-sign-in:authorize", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const origin = getPublicOrigin(request);
  const params = request.nextUrl.searchParams;

  let token = params.get("request") ?? "";
  if (!token) {
    const challenge = params.get("code_challenge");
    const state = params.get("state");
    if (!validState(state)) {
      return jsonError("invalid_state", 400);
    }
    if (!validChallenge(challenge) || (params.get("code_challenge_method") ?? "S256") !== "S256") {
      return NextResponse.redirect(appSignInCallbackUrl({ error: "invalid_request", state }));
    }
    token = await createAppSignInRequestToken({
      challenge,
      provider: params.get("provider") === "google" ? "google" : undefined,
      reauth: params.get("reauth") === "1",
      state,
    });
  }
  const signInRequest = await verifyAppSignInRequestToken(token);
  if (!signInRequest) {
    return NextResponse.redirect(new URL("/login?error=invalid_state", origin));
  }
  if (params.get("cancel") === "1") {
    return NextResponse.redirect(
      appSignInCallbackUrl({ error: "access_denied", state: signInRequest.state }),
    );
  }

  const { db } = requireDatabase();
  if (!db) {
    return NextResponse.redirect(
      appSignInCallbackUrl({ error: "temporarily_unavailable", state: signInRequest.state }),
    );
  }

  const self = `/api/auth/app/authorize?request=${encodeURIComponent(token)}`;
  const step = await appSignInStep(db, signInRequest, false);
  switch (step.kind) {
    case "sign_in":
      return NextResponse.redirect(new URL(signInPath(signInRequest, self), origin));
    case "reauth":
      return NextResponse.redirect(
        new URL(`${reauthPath}?return_to=${encodeURIComponent(self)}`, origin),
      );
    case "confirm":
      return NextResponse.redirect(
        new URL(`/login/app?request=${encodeURIComponent(token)}`, origin),
      );
    case "code":
      return NextResponse.redirect(step.redirect);
  }
}

// "Continue as …" on /login/app. A fetch, not a form post: the page then
// navigates to the frameos:// redirect itself, which the CSP's form-action
// would refuse after a form submission.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "app-sign-in:confirm", {
    limit: 30,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const body = await readJsonObject(request);
  const signInRequest =
    typeof body.request === "string"
      ? await verifyAppSignInRequestToken(body.request)
      : undefined;
  if (!signInRequest) {
    return jsonError("invalid_state", 400);
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const step = await appSignInStep(db, signInRequest, true);
  switch (step.kind) {
    case "code":
      return NextResponse.json({ ok: true, redirect: step.redirect });
    case "reauth":
      return jsonError("reauth_required", 403);
    default:
      return jsonError("login_required", 401);
  }
}

function signInPath(signInRequest: AppSignInRequest, returnTo: string) {
  if (signInRequest.provider === "google" && hasGoogleOAuth()) {
    return `/api/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
  }
  return `/login?return_to=${encodeURIComponent(returnTo)}`;
}
