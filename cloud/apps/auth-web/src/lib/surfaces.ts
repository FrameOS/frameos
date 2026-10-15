import {
  getAccountBaseUrl,
  getAccountPath,
  getCloudBaseUrl,
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
// surface, and "/account" its settings pages (app/account/[[...section]]
// serves the same shell); "/frames-app" holds its static assets and is
// treated as an asset path below.
const accountPagePrefixes = [
  "/account",
  "/admin",
  "/device",
  "/frames",
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

// The old homes of the private scene list — /account/scenes and its clean
// alias /scenes — moved to the scenes host as the store's second tab.
function isLegacyMyScenesPath(pathname: string) {
  return pathname === "/scenes" || pathname === "/account/scenes";
}

// Only redirects today; "rewrite" stays in the shape so proxy.ts keeps its
// branch for the next path that has to be served under another name.
export type SurfaceRoute = {
  destination: URL;
  kind: "redirect" | "rewrite";
};

// All three hostnames reach one Next.js process. Human pages get canonical
// hosts and clean account paths, while API routes stay available everywhere
// for existing FrameOS links and clients.
export function resolveSurfaceRoute(
  requestUrl: URL,
  requestHost?: string | null,
): SurfaceRoute | undefined {
  const account = new URL(getAccountBaseUrl());
  const cloud = new URL(getCloudBaseUrl());
  const scenes = new URL(getScenesBaseUrl());
  if (new Set([account.origin, cloud.origin, scenes.origin]).size === 1) {
    return undefined;
  }

  const host = (requestHost ?? requestUrl.host).trim().toLowerCase();
  const pathname = requestUrl.pathname;
  if (isApiOrAsset(pathname)) {
    return undefined;
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
      // With the account surface on this host, the root is the frames
      // workspace; its own sign-in gate handles signed-out visitors.
      // Otherwise the cloud host is only the login door.
      return accountIsCloud
        ? redirectTo(requestUrl, account, "/frames")
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
      return redirectTo(requestUrl, account, "/frames");
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
