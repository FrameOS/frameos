import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@frameos-cloud/db";
import { hasDatabaseUrl } from "./src/lib/env";
import {
  sessionCookieName,
  sessionCookieOptions,
} from "./src/lib/session-cookie";
import {
  refreshSessionRow,
  sessionCookieMaxAgeSeconds,
} from "./src/lib/session-refresh";
import {
  flasherRootHeader,
  isAnonymousHost,
  playgroundRootHeader,
  resolveSurfaceRoute,
} from "./src/lib/surfaces";

export async function proxy(request: NextRequest) {
  const response = routeSurface(request);
  // A surface redirect carries no session decision; the request it sends the
  // browser to will refresh instead. Nor does anything on the playground or
  // flasher host: it is served as to a stranger (routeSurface), so its
  // responses never extend a session.
  if (
    (response.status < 300 || response.status >= 400) &&
    !isAnonymousHost(request.nextUrl, request.headers.get("host"))
  ) {
    await refreshSessionCookie(request, response);
  }
  return response;
}

function routeSurface(request: NextRequest) {
  const host = request.headers.get("host");
  const route = resolveSurfaceRoute(request.nextUrl, host, request.method);
  if (route?.kind === "notFound") {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  if (route?.kind === "redirect") {
    // 307, never 308: which host serves which path is deployment config, and
    // it has changed under browsers before — the cloud root used to redirect
    // to /login, and every browser that cached that permanent redirect kept
    // going there long after the root became the account home. A temporary
    // redirect with no-store keeps a routing change from freezing into caches.
    return NextResponse.redirect(route.destination, {
      status: 307,
      headers: { "cache-control": "no-store" },
    });
  }

  // The playground's and the flasher's host roots are rewritten by
  // next.config.ts on these marks (playgroundRootRewrite in surfaces.ts says
  // why not here). The marks are the proxy's alone: one a client sent is
  // dropped from every other request.
  const playgroundRoot = route?.kind === "playgroundRoot";
  const flasherRoot = route?.kind === "flasherRoot";
  // The playground runs anyone's scene, and the flasher takes jobs from
  // pages it does not know, on origins the session cookie is also sent to
  // (it is scoped to the registrable domain). Nothing served on those hosts
  // may see who is asking: the cookie and any bearer are taken off before a
  // page or a route handler reads the request.
  const anonymous = isAnonymousHost(request.nextUrl, host);
  if (
    !playgroundRoot &&
    !flasherRoot &&
    !anonymous &&
    !request.headers.has(playgroundRootHeader) &&
    !request.headers.has(flasherRootHeader)
  ) {
    return NextResponse.next();
  }
  const headers = new Headers(request.headers);
  if (playgroundRoot) {
    headers.set(playgroundRootHeader, "1");
  } else {
    headers.delete(playgroundRootHeader);
  }
  if (flasherRoot) {
    headers.set(flasherRootHeader, "1");
  } else {
    headers.delete(flasherRootHeader);
  }
  if (anonymous) {
    headers.delete("cookie");
    headers.delete("authorization");
  }
  return NextResponse.next({ request: { headers } });
}

// Paths that mint or clear the session cookie themselves. Refreshing here
// would add a second Set-Cookie for the same name and race the handler's own
// — a logout that hands back a live cookie is exactly the bug worth avoiding.
const sessionWritingPathPrefixes = [
  "/api/account/password",
  "/api/auth/",
  "/logout",
];

// Static bundles: served straight from disk, never carry a session decision,
// and are the bulk of the request count. Skipping them keeps the refresh off
// the hot path entirely. (The matcher below already excludes /_next/static.)
const staticPathPrefixes = ["/_next/", "/frameos-editor/", "/frames-app/"];

// Extends the session on the way past — at most once an hour per session —
// and re-issues the cookie with a full idle window.
//
// This is the only legal place for it in Next 16: readSession() runs inside
// React Server Components, where cookies().set() throws, while the proxy can
// set cookies on the response it returns. Next 16 always runs the proxy on the
// Node.js runtime (exporting `runtime` from this file is a build error), so
// the postgres driver behind @frameos-cloud/db is safe to use here.
async function refreshSessionCookie(
  request: NextRequest,
  response: NextResponse,
) {
  const token = request.cookies.get(sessionCookieName)?.value;
  // Devices and linked backends authenticate with bearer tokens and send no
  // cookie, so their traffic — /api/frames/enroll and the rest of the device
  // surface — never reaches the database call below.
  if (!token || !hasDatabaseUrl()) {
    return;
  }
  const path = request.nextUrl.pathname;
  if (
    sessionWritingPathPrefixes.some((prefix) => path.startsWith(prefix)) ||
    staticPathPrefixes.some((prefix) => path.startsWith(prefix))
  ) {
    return;
  }

  try {
    const now = new Date();
    const refreshed = await refreshSessionRow(createDb(), token, now);
    if (!refreshed) {
      return;
    }
    response.cookies.set(
      sessionCookieName,
      token,
      sessionCookieOptions(sessionCookieMaxAgeSeconds(refreshed, now)),
    );
    // A response carrying a session Set-Cookie must not sit in a shared
    // cache, whatever the route's own caching headers say.
    response.headers.set("Cache-Control", "private, no-store");
  } catch (error) {
    // Best effort: a database hiccup must not turn every page into an error.
    // The session simply stays on its current deadline — but say so, because a
    // refresh that silently never runs looks exactly like the fixed-lifetime
    // logout bug this replaced.
    console.error("Session refresh failed:", error);
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
