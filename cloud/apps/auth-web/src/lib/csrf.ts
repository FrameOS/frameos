import { NextRequest, NextResponse } from "next/server";
import {
  apiTokenAccessFromPrefix,
  bearerToken,
  isApiToken,
} from "./api-tokens";
import { getAppOrigins } from "./env";
import { sessionCookieName } from "./session-cookie";

// Origin check for cookie-authenticated mutations. A request that carries a
// personal API token instead is exempt — a browser never attaches a bearer
// on its own, so there is no ambient credential to forge a request with —
// but a read-only token is stopped right here, before the route does any
// work: every mutating route calls this first, which makes it the one place
// that sees the method and the credential together. (readSession() still
// verifies the token's row says the same thing as its prefix.) A job token
// (`fc_apijob_`) passes here like a full token — it is a bearer, so there is
// no ambient credential either — and is then refused by readSession() on
// every route but the one that authenticates it itself (authenticateJobToken).
//
// The exemption follows the credential the route will actually use, not the
// one the request merely carries: readSession() reads the session cookie
// first and looks at the bearer only when there is none, so a request with
// both is a cookie request and gets the Origin check — otherwise any page
// could send `Authorization: Bearer fc_api_x` alongside the victim's cookie.
export function csrfResponse(request: NextRequest) {
  const token = bearerToken(request.headers.get("authorization"));
  if (isApiToken(token) && !request.cookies.has(sessionCookieName)) {
    if (apiTokenAccessFromPrefix(token) === "read_only") {
      return NextResponse.json({ error: "read_only_token" }, { status: 403 });
    }
    return undefined;
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    return NextResponse.json({ error: "missing_origin" }, { status: 403 });
  }

  if (!getAppOrigins().has(origin)) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }

  return undefined;
}
