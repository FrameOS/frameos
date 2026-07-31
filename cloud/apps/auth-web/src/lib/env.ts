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
  return optionalEnv("FRAMEOS_CLOUD_APP_URL") ?? "http://localhost:3000";
}

// Account, device approval, and administration pages live here in
// production. It falls back to the cloud origin so local development keeps
// the existing /account/* routes on one localhost port.
export function getAccountBaseUrl() {
  return optionalEnv("FRAMEOS_ACCOUNT_APP_URL") ?? getCloudBaseUrl();
}

// Local development deliberately defaults to the cloud URL, so both surfaces
// continue to run through one localhost port. Production sets this to the
// dedicated scenes.frameos.net origin.
export function getScenesBaseUrl() {
  return optionalEnv("FRAMEOS_SCENES_APP_URL") ?? getCloudBaseUrl();
}

export function getAppOrigins() {
  return new Set([
    new URL(getAccountBaseUrl()).origin,
    new URL(getCloudBaseUrl()).origin,
    new URL(getScenesBaseUrl()).origin,
  ]);
}

export function getAccountPath(path: string) {
  if (
    new URL(getAccountBaseUrl()).origin === new URL(getCloudBaseUrl()).origin
  ) {
    return path;
  }

  if (path === "/account" || path === "/account/installs") {
    return "/";
  }
  if (path.startsWith("/account/")) {
    return path.slice("/account".length);
  }
  return path;
}

export function getAccountUrl(path = "/account") {
  return new URL(getAccountPath(path), getAccountBaseUrl()).toString();
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
