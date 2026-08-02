import { NextRequest, NextResponse } from "next/server";
import {
  authenticateLinkedClient,
  linkedClientHasScope,
} from "../../../../../src/lib/backend-auth";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { getBaseUrl } from "../../../../../src/lib/env";
import {
  createFrameosLoginRequestToken,
  safeFrameosRedirectUri,
} from "../../../../../src/lib/frameos-login";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const limited = await rateLimitResponse(request, "frameos-login:start", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const linkedClient = await authenticateLinkedClient(
    db,
    request.headers.get("authorization"),
  );
  if (!linkedClient) {
    return jsonError("invalid_link_token", 401);
  }
  if (!linkedClientHasScope(linkedClient, "auth:login")) {
    return jsonError("insufficient_scope", 403);
  }

  const body = await readJsonObject(request);
  const redirectUri = safeFrameosRedirectUri(body.redirect_uri);
  if (!redirectUri) {
    return jsonError("invalid_redirect_uri", 400);
  }
  if (!redirectMatchesLinkedBackend(redirectUri, linkedClient.localOrigin)) {
    return jsonError("invalid_redirect_uri", 400);
  }

  const state = typeof body.state === "string" ? body.state.trim() : "";
  if (!state) {
    return jsonError("invalid_state", 400);
  }
  const intent = body.intent === "signup" ? "signup" : "login";
  const redirectTo =
    typeof body.redirect_to === "string" ? body.redirect_to : undefined;

  const loginRequest = await createFrameosLoginRequestToken({
    intent,
    linkedClientId: linkedClient.id,
    redirectTo,
    redirectUri,
    state,
  });
  const authorizationUrl = new URL(
    "/api/frameos/login/authorize",
    getBaseUrl(),
  );
  authorizationUrl.searchParams.set("request", loginRequest);

  return NextResponse.json({
    authorization_url: authorizationUrl.toString(),
    expires_in: 10 * 60,
  });
}

function redirectMatchesLinkedBackend(
  redirectUri: string,
  localOrigin: string | null,
) {
  if (!localOrigin) {
    return false;
  }

  try {
    return new URL(redirectUri).origin === new URL(localOrigin).origin;
  } catch {
    return false;
  }
}
