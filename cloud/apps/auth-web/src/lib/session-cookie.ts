import { getSessionCookieDomain } from "./env";

// Session lifetime lives here, apart from session.ts, because the Next proxy
// (proxy.ts) refreshes sessions and must not pull in next/headers.
//
// Sessions slide. A session dies after `sessionIdleMaxAgeSeconds` without
// activity, and can never live longer than `sessionAbsoluteMaxAgeSeconds` no
// matter how active it is — at the ceiling the user signs in again. Thirty
// days of idle is the consumer-product norm (the cookie is httpOnly,
// __Host-/__Secure- prefixed, sameSite=lax, and every request revalidates a
// revocable server-side row), and ninety days bounds the damage of a cookie
// stolen from a device that is never signed out.
export const sessionIdleMaxAgeSeconds = 30 * 24 * 60 * 60;
export const sessionAbsoluteMaxAgeSeconds = 90 * 24 * 60 * 60;

// How stale a session must be before activity rewrites the row and cookie.
// Refreshing per request would mean a row update and a Set-Cookie on every
// navigation and XHR; once an hour keeps the idle window accurate to within
// 0.1% of its length for a cost of one UPDATE per session per hour.
export const sessionRefreshIntervalSeconds = 60 * 60;

// Split production uses a parent-domain cookie so cloud.frameos.net and
// scenes.frameos.net share one login. Domain cookies cannot use __Host-, so
// retain the __Secure- prefix there; single-origin production keeps the more
// restrictive __Host- prefix. Plain-HTTP development uses the bare name.
export const sessionCookieName =
  process.env.NODE_ENV === "production"
    ? getSessionCookieDomain()
      ? "__Secure-frameos_cloud_session"
      : "__Host-frameos_cloud_session"
    : "frameos_cloud_session";

// maxAge is the idle window: every refresh re-issues the cookie with a full
// window, so the browser drops it at exactly the point the server would stop
// honouring it. Callers that know the remaining absolute lifetime pass it in
// so the cookie cannot outlive the ceiling either.
export function sessionCookieOptions(
  maxAgeSeconds: number = sessionIdleMaxAgeSeconds,
) {
  const domain = getSessionCookieDomain();
  return {
    ...(domain ? { domain } : {}),
    httpOnly: true,
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}
