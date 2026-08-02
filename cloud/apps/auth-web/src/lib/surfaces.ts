import {
  getAccountBaseUrl,
  getAccountPath,
  getCloudBaseUrl,
  getScenesBaseUrl,
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
// surface; "/frames-app" holds its static assets and is treated as an
// asset path below.
const accountPagePrefixes = ["/account", "/admin", "/device", "/frames"] as const;
const accountSectionRewrites = new Map([
  ["/", "/account/installs"],
  ["/scenes", "/account/scenes"],
  ["/backups", "/account/backups"],
  ["/activity", "/account/activity"],
  ["/security", "/account/security"],
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

  if (host === cloud.host.toLowerCase()) {
    if (matchesAny(pathname, authPagePrefixes)) {
      return undefined;
    }
    if (isPublicScenePath(pathname)) {
      return redirectTo(requestUrl, scenes, pathname);
    }
    if (pathname === "/") {
      return redirectTo(requestUrl, cloud, "/login");
    }
    if (matchesAny(pathname, accountPagePrefixes)) {
      return redirectTo(requestUrl, account, getAccountPath(pathname));
    }
  }

  if (host === scenes.host.toLowerCase()) {
    if (pathname === "/" || isPublicScenePath(pathname)) {
      return undefined;
    }
    if (matchesAny(pathname, authPagePrefixes)) {
      return redirectTo(requestUrl, cloud, pathname);
    }
    if (matchesAny(pathname, accountPagePrefixes)) {
      return redirectTo(requestUrl, account, getAccountPath(pathname));
    }
  }

  if (host === account.host.toLowerCase()) {
    if (matchesAny(pathname, authPagePrefixes)) {
      return redirectTo(requestUrl, cloud, pathname);
    }
    if (isPublicScenePath(pathname)) {
      return redirectTo(requestUrl, scenes, pathname);
    }
    if (pathMatchesPrefix(pathname, "/account")) {
      // getAccountPath keeps some paths as-is (e.g. "/account/frames", which
      // cannot shorten into the /frames SPA) — serve those directly instead
      // of redirecting a URL to itself.
      const cleanPath = getAccountPath(pathname);
      if (cleanPath === pathname) {
        return undefined;
      }
      return redirectTo(requestUrl, account, cleanPath);
    }
    if (pathname === "/installs") {
      return redirectTo(requestUrl, account, "/");
    }
    const internalPath = accountSectionRewrites.get(pathname);
    if (internalPath) {
      return rewriteTo(requestUrl, internalPath);
    }
  }

  return undefined;
}

function redirectTo(source: URL, origin: URL, pathname: string): SurfaceRoute {
  const destination = new URL(origin);
  destination.pathname = pathname;
  destination.search = source.search;
  destination.hash = source.hash;
  return { destination, kind: "redirect" };
}

function rewriteTo(source: URL, pathname: string): SurfaceRoute {
  const destination = new URL(source);
  destination.pathname = pathname;
  return { destination, kind: "rewrite" };
}
