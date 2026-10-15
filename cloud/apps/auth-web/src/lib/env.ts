export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  issuerUrl: string;
};

export const googleIssuerUrl = "https://accounts.google.com";

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getBaseUrl() {
  return getCloudBaseUrl();
}

// Login, logout, recovery, and OAuth stay on the cloud origin. getBaseUrl
// remains as a compatibility alias for that auth origin while call sites that
// deliberately belong to one surface use the explicit names.
export function getCloudBaseUrl() {
  return devLocalUrl(optionalEnv("FRAMEOS_CLOUD_APP_URL") ?? "http://localhost:3000");
}

// `next dev` takes the next free port when 3000 is busy and records the one
// it got in process.env.PORT (next/dist/server/lib/start-server.js), while
// .env.local still says 3000. Every absolute URL built here would then point
// at whatever else is on 3000. Outside production a configured localhost URL
// follows the port this server actually listens on.
function devLocalUrl(url: string) {
  const port = process.env.PORT?.trim();
  if (process.env.NODE_ENV === "production" || !port) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      return url;
    }
    if (parsed.port === port) {
      return url;
    }
    parsed.port = port;
    const rebuilt = parsed.toString();
    return url.endsWith("/") ? rebuilt : rebuilt.replace(/\/$/, "");
  } catch {
    return url;
  }
}

// Account, device approval, and administration pages live here in
// production. It falls back to the cloud origin so local development keeps
// the existing /account/* routes on one localhost port.
export function getAccountBaseUrl() {
  const configured = optionalEnv("FRAMEOS_ACCOUNT_APP_URL");
  return configured ? devLocalUrl(configured) : getCloudBaseUrl();
}

// Local development deliberately defaults to the cloud URL, so both surfaces
// continue to run through one localhost port. Production sets this to the
// dedicated scenes.frameos.net origin.
export function getScenesBaseUrl() {
  const configured = optionalEnv("FRAMEOS_SCENES_APP_URL");
  return configured ? devLocalUrl(configured) : getCloudBaseUrl();
}

export function getAppOrigins() {
  return new Set([
    new URL(getAccountBaseUrl()).origin,
    new URL(getCloudBaseUrl()).origin,
    new URL(getScenesBaseUrl()).origin,
  ]);
}

/**
 * The origin the browser actually used, for URLs that have to work outside
 * this process.
 *
 * `new URL(request.url).origin` cannot answer that question. Behind nginx,
 * Next reports the address it is listening on, which in production is
 * `https://localhost:3000` — so anything built from it points at a host only
 * the server can reach. That shipped: /install.sh stamped
 * FRAMEOS_CLOUD_URL_DEFAULT="https://localhost:3000" into the installer, and
 * the FrameOS login redirect sent people to localhost.
 *
 * The Host header does carry the truth, but trusting it verbatim would let
 * anyone able to set it stamp their own hostname into an install command
 * piped to a shell. So it is matched against the origins this deployment has
 * configured, and anything unrecognised falls back to the cloud origin.
 */
export function getPublicOrigin(request: {
  headers: Headers;
  url: string;
}): string {
  const header =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    "";
  // A proxy chain can leave a list; the first entry is the client's.
  const host = header.split(",")[0]?.trim().toLowerCase() ?? "";
  const ownOrigin = safeOrigin(request.url);
  // No Host header means nothing is proxying us, so the URL this process was
  // asked for is the whole truth — that is the development case, Next serving
  // a LAN address directly so a frame can enrol against a laptop.
  if (!host) {
    return ownOrigin ?? new URL(getCloudBaseUrl()).origin;
  }
  // Otherwise the header is only trusted when it names an origin this
  // deployment has configured, or the one this process is itself serving.
  for (const origin of [...getAppOrigins(), ownOrigin]) {
    if (origin && new URL(origin).host.toLowerCase() === host) {
      return origin;
    }
  }
  return new URL(getCloudBaseUrl()).origin;
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

// The account's pages are scenes of the frames workspace SPA since 2026.10
// (frontend/src/scenes/settings/account/accountPages.ts): one route each
// under /frames/settings. These are the old /account/<section> app routes
// (and their clean split-host spellings, /backends and the like) mapped
// onto them, so every link built with getAccountUrl("/account/…") — and
// every bookmark the surface router (surfaces.ts) redirects — lands on the
// right page. The SPA's own keys are the public URL segments; a new page
// is a row here AND an entry in the SPA's list, which the cloud-frames
// routes test keeps in step.
export const accountSectionSpaPaths: ReadonlyMap<string, string> = new Map([
  ["/account", "/frames/settings"],
  ["/account/installs", "/frames/settings/backends"],
  ["/account/settings", "/frames/settings/services"],
  ["/account/usage", "/frames/settings/usage"],
  // AI usage moved onto the usage page in 2026.10; the anchor still lands.
  ["/account/ai", "/frames/settings/usage#ai"],
  ["/account/backups", "/frames/settings/backups"],
  ["/account/activity", "/frames/settings/activity"],
  ["/account/security", "/frames/settings/security"],
  ["/account/developer", "/frames/settings/developer"],
]);

export function getAccountPath(path: string) {
  // A fragment or a query rides along: "/account/usage#ai" is the usage
  // page's AI anchor, which the map above may itself carry.
  const suffixAt = path.search(/[?#]/);
  const bare = suffixAt === -1 ? path : path.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : path.slice(suffixAt);
  const spaPath = accountSectionSpaPaths.get(bare.replace(/\/+$/, "") || "/");
  if (spaPath) {
    return spaPath.includes("#") && suffix.startsWith("#") ? spaPath.slice(0, spaPath.indexOf("#")) + suffix : spaPath + suffix;
  }

  // Only local development runs every surface on one origin; there the
  // remaining /account/* app routes are the real URLs and nothing shortens.
  // In production the account surface shares the cloud origin (with scenes
  // on its own host), and clean paths still apply.
  if (getAppOrigins().size === 1) {
    return path;
  }

  if (bare.startsWith("/account/")) {
    return path.slice("/account".length);
  }
  return path;
}

export function getAccountUrl(path = "/account") {
  return new URL(getAccountPath(path), getAccountBaseUrl()).toString();
}

// The settings pages of the fleet workspace (the former account pages).
export function getAccountSettingsUrl(page?: string) {
  return getAccountUrl(page ? `/frames/settings/${page}` : "/account");
}

// The fleet workspace SPA (app/frames/[[...path]]) — the one and only frames
// page; the old /account/frames table redirects here.
export function getFramesUrl() {
  return new URL("/frames", getAccountBaseUrl()).toString();
}

// The public store front. On its own host (production: scenes.frameos.net)
// it is the root; when the store shares an origin with the cloud app (local
// development) the root belongs to the signed-in workspace redirect, so the
// store front answers at /store instead (app/store/page.tsx serves both).
export function getStorePath() {
  return new URL(getScenesBaseUrl()).origin ===
    new URL(getCloudBaseUrl()).origin
    ? "/store"
    : "/";
}

export function getStoreUrl() {
  return new URL(getStorePath(), getScenesBaseUrl()).toString();
}

// "My scenes": the second tab of the scene store, on the scenes host
// next to the public store front. It replaced /account/scenes (and its clean
// alias /scenes on the cloud host), which now redirect here.
export const myScenesPath = "/my-scenes";

export function getMyScenesUrl() {
  return new URL(myScenesPath, getScenesBaseUrl()).toString();
}

// The Nim → JavaScript scene converter: a public page on the scenes host
// (docs/nim-to-js-conversion.md), next to the store and "My scenes".
export const nimConverterPath = "/nim-converter";

export function getNimConverterUrl() {
  return new URL(nimConverterPath, getScenesBaseUrl()).toString();
}

export function getSessionCookieDomain() {
  const configured = optionalEnv("FRAMEOS_SESSION_COOKIE_DOMAIN");
  if (!configured) {
    return undefined;
  }

  const domain = configured.replace(/^\./, "").toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(domain)) {
    throw new Error("FRAMEOS_SESSION_COOKIE_DOMAIN must be a hostname");
  }

  for (const baseUrl of [
    getAccountBaseUrl(),
    getCloudBaseUrl(),
    getScenesBaseUrl(),
  ]) {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname !== domain && !hostname.endsWith(`.${domain}`)) {
      throw new Error(
        `FRAMEOS_SESSION_COOKIE_DOMAIN does not cover ${hostname}`,
      );
    }
  }

  return domain;
}

export function assertSharedSessionConfigured() {
  if (getAppOrigins().size > 1 && !getSessionCookieDomain()) {
    throw new Error(
      "FRAMEOS_SESSION_COOKIE_DOMAIN is required when FrameOS app URLs use different origins",
    );
  }
}

export function getGoogleCallbackUrl() {
  return new URL("/api/auth/google/callback", getCloudBaseUrl()).toString();
}

export function getPostLogoutRedirectUrl() {
  return new URL("/login?status=signed_out", getCloudBaseUrl()).toString();
}

// Google SSO is optional: without a configured OAuth client the login page
// simply hides the Google button and password auth keeps working.
export function getGoogleOAuthConfig(): GoogleOAuthConfig | undefined {
  const clientId = optionalEnv("GOOGLE_CLIENT_ID");
  const clientSecret = optionalEnv("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return undefined;
  }

  return {
    clientId,
    clientSecret,
    issuerUrl: optionalEnv("GOOGLE_ISSUER_URL") ?? googleIssuerUrl,
  };
}

export function hasGoogleOAuth() {
  return Boolean(getGoogleOAuthConfig());
}

export function getSessionSecret() {
  return requireEnv("SESSION_SECRET");
}

export function getEncryptionKey() {
  return requireEnv("FRAMEOS_CLOUD_ENCRYPTION_KEY");
}

export function assertDatabaseUrlConfigured(options?: {
  allowTestEnvironment?: boolean;
}) {
  if (optionalEnv("DATABASE_URL")) {
    return;
  }

  if (options?.allowTestEnvironment && isTestEnvironment()) {
    return;
  }

  throw new Error(
    "Missing required environment variable: DATABASE_URL. Configure a database before starting FrameOS Cloud.",
  );
}

export function hasDatabaseUrl() {
  return Boolean(optionalEnv("DATABASE_URL"));
}

function isTestEnvironment() {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}
