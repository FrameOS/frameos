import {
  getAccountBaseUrl,
  getAccountPath,
  getCloudBaseUrl,
  getFlasherBaseUrl,
  getPlaygroundBaseUrl,
  getScenesBaseUrl,
  myScenesPath,
  nimConverterPath,
} from "./env";

const authPagePrefixes = [
  "/login",
  "/logout",
  "/recovery",
  "/reset",
  "/signup",
  "/verify-email",
] as const;

// "/frames" is the cloud frames SPA (app/frames/[[...path]]), an account
// surface; "/account" (its settings pages), "/apps" and "/photos" are the
// same shell served at the SPA's other roots (app/account, app/apps and
// app/photos delegate to the frames route). "/frames-app" holds its static
// assets and is treated as an asset path below.
const accountPagePrefixes = [
  "/account",
  "/admin",
  "/apps",
  "/device",
  "/frames",
  "/home",
  "/photos",
  // The scenes library (exactly /scenes: /scenes/<slug> is a public scene
  // page's legacy address and is matched as one before this list).
  "/scenes",
] as const;
// The clean split-host spellings the account sections had until 2026.10
// (/backends, /settings, …), when the sections became pages of the frames
// workspace SPA at their /account/<page> addresses. Bookmarks and emails
// still carry them; each redirects to its page through getAccountPath
// (env.ts accountSectionRedirects renames the sections that moved).
const legacyAccountSectionPaths = new Map([
  ["/backends", "/account/installs"],
  ["/installs", "/account/installs"],
  ["/usage", "/account/usage"],
  ["/ai", "/account/ai"],
  ["/settings", "/account/settings"],
  ["/backups", "/account/backups"],
  ["/activity", "/account/activity"],
  ["/security", "/account/security"],
  ["/developer", "/account/developer"],
]);

function pathMatchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function matchesAny(pathname: string, prefixes: readonly string[]) {
  return prefixes.some((prefix) => pathMatchesPrefix(pathname, prefix));
}

function isApiOrAsset(pathname: string) {
  return (
    pathMatchesPrefix(pathname, "/api") ||
    pathMatchesPrefix(pathname, "/_next") ||
    pathMatchesPrefix(pathname, "/frameos-editor") ||
    pathMatchesPrefix(pathname, "/frameos-wasm") ||
    pathMatchesPrefix(pathname, "/frames-app") ||
    // The playground's scenes (scripts/build-playground-scenes.mjs).
    pathMatchesPrefix(pathname, "/playground-assets") ||
    // The standalone frame installer (curl -fsSL {origin}/install.sh | sh),
    // copied from scripts/frameos-setup.sh by copy-install-script.mjs.
    pathname === "/install.sh" ||
    // The un-stamped copy the /install.sh route reads from. Public either way
    // — it is the same script as on GitHub — but it must not host-route.
    pathname === "/install.template.sh" ||
    pathname === "/favicon.ico" ||
    pathname === "/logo-dark.svg" ||
    pathname === "/logo-light.svg" ||
    pathname === "/logo.png"
  );
}

export function isPublicScenePath(pathname: string) {
  return (
    pathname.startsWith("/scenes/") ||
    pathname.startsWith("/s/") ||
    pathMatchesPrefix(pathname, "/publishers")
  );
}

// Everything the scenes host serves besides its store front: public scene
// pages, the signed-in "My scenes" tab and the Nim → JavaScript converter.
function isScenesHostPath(pathname: string) {
  return (
    isPublicScenePath(pathname) ||
    pathname === myScenesPath ||
    pathname === nimConverterPath
  );
}

// The old home of the private scene list — /account/scenes — moved to the
// scenes host as the store's second tab. (/scenes, once its clean alias,
// is the SPA's scenes library since 2026.10.)
function isLegacyMyScenesPath(pathname: string) {
  return pathname === "/account/scenes";
}

// The playground's page is app/playground; on its own host it is the root.
export const playgroundPath = "/playground";

// How the playground host's root becomes that page: proxy.ts marks the
// request with this header and next.config.ts rewrites it, inside Next's
// router. Never a rewrite returned by the proxy: Next keeps one inside the
// server only when its origin is the one the server was started on
// (HOSTNAME=127.0.0.1 in production), and the proxy only ever sees that host
// as `localhost`, so every such rewrite became an HTTP request back into this
// server, which the rules below sent to the root again: a redirect loop at
// playground.frameos.net the day it went live (2026-11-16).
export const playgroundRootHeader = "x-frameos-playground-root";

export const playgroundRootRewrite = {
  source: "/",
  has: [{ type: "header" as const, key: playgroundRootHeader, value: "1" }],
  destination: playgroundPath,
};

// The browser flasher's page is app/flash (cloud/docs/flasher.md); on its
// own host it is the root, by the same mark-and-rewrite as the playground's.
export const flasherPath = "/flash";
export const flasherRootHeader = "x-frameos-flasher-root";

export const flasherRootRewrite = {
  source: "/",
  has: [{ type: "header" as const, key: flasherRootHeader, value: "1" }],
  destination: flasherPath,
};

export type SurfaceRoute =
  | { kind: "redirect"; destination: URL }
  // The playground host's root (playgroundRootRewrite).
  | { kind: "playgroundRoot" }
  // The flasher host's root (flasherRootRewrite).
  | { kind: "flasherRoot" }
  // An API path the playground or flasher host does not serve
  // (playgroundServesApi, flasherServesApi).
  | { kind: "notFound" };

// The playground runs anyone's store scene in a page whose origin shares the
// session cookie's domain. So its host is no door to the API: it answers the
// three anonymous things the playground itself asks for (the store's listing
// for frames, a public scene's files, the preview proxy) and nothing else,
// and proxy.ts takes the session cookie and any bearer off every request
// that arrives on it, so even those three are answered as to a stranger.
const playgroundApiReads = ["/api/store/device", "/api/store/scenes"] as const;
const playgroundPreviewProxyPath = "/api/store/preview-proxy";

export function playgroundServesApi(pathname: string, method = "GET") {
  if (pathname === playgroundPreviewProxyPath) {
    return true;
  }
  const verb = method.toUpperCase();
  return (
    (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") &&
    matchesAny(pathname, playgroundApiReads)
  );
}

// Whether a request arrived on the playground's own host (false while the
// playground is a path of the cloud origin, as in development).
export function isPlaygroundHost(requestUrl: URL, requestHost?: string | null) {
  const playground = new URL(getPlaygroundBaseUrl());
  if (playground.origin === new URL(getCloudBaseUrl()).origin) {
    return false;
  }
  const host = (requestHost ?? requestUrl.host).trim().toLowerCase();
  return host === playground.host.toLowerCase();
}

// The flasher is a page for people with no account, and it takes jobs (a
// frame's API key and Wi-Fi password among them) from pages it does not know
// (frontend/src/utils/flasherBridge.ts). So its host is no door to the API
// either: it answers what the flasher asks for — the release listing, the
// firmware and its signature (app/api/frames/firmware), and the store's
// public listing and its covers, which its scene list shows as thumbnails —
// and proxy.ts takes the cookie and any bearer off those too.
const flasherApiReads = ["/api/frames/firmware", "/api/store/repository.json"] as const;
const flasherStoreCover = /^\/api\/store\/scenes\/[0-9a-f-]{36}\/image$/;

export function flasherServesApi(pathname: string, method = "GET") {
  const verb = method.toUpperCase();
  return (
    (verb === "GET" || verb === "HEAD") &&
    ((flasherApiReads as readonly string[]).includes(pathname) || flasherStoreCover.test(pathname))
  );
}

// Whether a request arrived on the flasher's own host (false while the
// flasher is a path of the cloud origin, as in development).
export function isFlasherHost(requestUrl: URL, requestHost?: string | null) {
  const flasher = new URL(getFlasherBaseUrl());
  if (flasher.origin === new URL(getCloudBaseUrl()).origin) {
    return false;
  }
  const host = (requestHost ?? requestUrl.host).trim().toLowerCase();
  return host === flasher.host.toLowerCase();
}

/** A host whose every request is served as to a stranger. */
export function isAnonymousHost(requestUrl: URL, requestHost?: string | null) {
  return isPlaygroundHost(requestUrl, requestHost) || isFlasherHost(requestUrl, requestHost);
}

// All the hostnames reach one Next.js process. Human pages get canonical
// hosts and clean account paths, while API routes stay available everywhere
// for existing FrameOS links and clients.
export function resolveSurfaceRoute(
  requestUrl: URL,
  requestHost?: string | null,
  method = "GET",
): SurfaceRoute | undefined {
  const account = new URL(getAccountBaseUrl());
  const cloud = new URL(getCloudBaseUrl());
  const scenes = new URL(getScenesBaseUrl());
  const playground = new URL(getPlaygroundBaseUrl());
  const flasher = new URL(getFlasherBaseUrl());
  if (
    new Set([
      account.origin,
      cloud.origin,
      scenes.origin,
      playground.origin,
      flasher.origin,
    ]).size === 1
  ) {
    return undefined;
  }

  const host = (requestHost ?? requestUrl.host).trim().toLowerCase();
  const pathname = requestUrl.pathname;
  if (
    pathMatchesPrefix(pathname, "/api") &&
    ((isPlaygroundHost(requestUrl, requestHost) &&
      !playgroundServesApi(pathname, method)) ||
      (isFlasherHost(requestUrl, requestHost) &&
        !flasherServesApi(pathname, method)))
  ) {
    return { kind: "notFound" };
  }
  if (isApiOrAsset(pathname)) {
    return undefined;
  }

  // The flasher host serves the flasher at its root and nothing else: any
  // other page is the cloud's.
  const flasherIsOwnHost = flasher.origin !== cloud.origin;
  if (flasherIsOwnHost && host === flasher.host.toLowerCase()) {
    if (pathname === "/") {
      return { kind: "flasherRoot" };
    }
    if (pathname === flasherPath) {
      return redirectTo(requestUrl, flasher, "/");
    }
    return redirectTo(requestUrl, cloud, pathname);
  }
  if (flasherIsOwnHost && pathMatchesPrefix(pathname, flasherPath)) {
    return redirectTo(requestUrl, flasher, "/");
  }

  // The playground host serves the playground at its root and nothing else:
  // any other page is the cloud's.
  const playgroundIsOwnHost = playground.origin !== cloud.origin;
  if (playgroundIsOwnHost && host === playground.host.toLowerCase()) {
    if (pathname === "/") {
      return { kind: "playgroundRoot" };
    }
    if (pathname === playgroundPath) {
      return redirectTo(requestUrl, playground, "/");
    }
    return redirectTo(requestUrl, cloud, pathname);
  }
  if (playgroundIsOwnHost && pathMatchesPrefix(pathname, playgroundPath)) {
    return redirectTo(requestUrl, playground, "/");
  }

  // The account surface may share the cloud origin (production since
  // 2026-08): the cloud host then serves account pages itself instead of
  // bouncing to a second hostname.
  const accountIsCloud = account.origin === cloud.origin;

  if (host === cloud.host.toLowerCase()) {
    if (matchesAny(pathname, authPagePrefixes)) {
      return undefined;
    }
    if (isScenesHostPath(pathname)) {
      return redirectTo(requestUrl, scenes, pathname);
    }
    if (isLegacyMyScenesPath(pathname)) {
      return redirectTo(requestUrl, scenes, myScenesPath);
    }
    if (pathname === "/") {
      // With the account surface on this host, the root is the workspace's
      // home page; its own sign-in gate handles signed-out visitors.
      // Otherwise the cloud host is only the login door.
      return accountIsCloud
        ? redirectTo(requestUrl, account, "/home")
        : redirectTo(requestUrl, cloud, "/login");
    }
    if (matchesAny(pathname, accountPagePrefixes)) {
      const cleanPath = getAccountPath(pathname);
      if (accountIsCloud && cleanPath === pathname) {
        // Paths that keep their full form (/admin, /device, the /frames SPA
        // and its /account pages) are served here — redirecting would loop.
        return undefined;
      }
      return redirectTo(requestUrl, account, cleanPath);
    }
    if (accountIsCloud) {
      const legacyPath = legacyAccountSectionPaths.get(pathname);
      if (legacyPath) {
        return redirectTo(requestUrl, account, getAccountPath(legacyPath));
      }
    }
  }

  if (host === scenes.host.toLowerCase()) {
    if (pathname === "/" || isScenesHostPath(pathname)) {
      return undefined;
    }
    if (isLegacyMyScenesPath(pathname)) {
      return redirectTo(requestUrl, scenes, myScenesPath);
    }
    if (matchesAny(pathname, authPagePrefixes)) {
      return redirectTo(requestUrl, cloud, pathname);
    }
    if (matchesAny(pathname, accountPagePrefixes)) {
      return redirectTo(requestUrl, account, getAccountPath(pathname));
    }
  }

  if (host === account.host.toLowerCase() && !accountIsCloud) {
    if (matchesAny(pathname, authPagePrefixes)) {
      return redirectTo(requestUrl, cloud, pathname);
    }
    if (isScenesHostPath(pathname)) {
      return redirectTo(requestUrl, scenes, pathname);
    }
    if (isLegacyMyScenesPath(pathname)) {
      return redirectTo(requestUrl, scenes, myScenesPath);
    }
    if (pathname === "/") {
      return redirectTo(requestUrl, account, "/home");
    }
    if (pathMatchesPrefix(pathname, "/account")) {
      // getAccountPath keeps some paths as-is — serve those directly instead
      // of redirecting a URL to itself.
      const cleanPath = getAccountPath(pathname);
      if (cleanPath === pathname) {
        return undefined;
      }
      return redirectTo(requestUrl, account, cleanPath);
    }
    const legacyPath = legacyAccountSectionPaths.get(pathname);
    if (legacyPath) {
      return redirectTo(requestUrl, account, getAccountPath(legacyPath));
    }
  }

  return undefined;
}

function redirectTo(source: URL, origin: URL, path: string): SurfaceRoute {
  // `path` may carry its own fragment (an account section that moved onto
  // an anchor of a page); the request's own fragment never reaches a server
  // anyway, and its query rides along.
  const destination = new URL(path, origin);
  destination.search = source.search;
  if (!destination.hash) {
    destination.hash = source.hash;
  }
  return { destination, kind: "redirect" };
}
