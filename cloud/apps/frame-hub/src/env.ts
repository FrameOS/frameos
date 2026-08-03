import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
// auth-web's env helpers are Next-free (same reason the hub can import
// src/lib/frames.ts), so the two services derive the browser origins from
// exactly the same variables — see cloud/docs/deployment.md ("Production
// uses: FRAMEOS_CLOUD_APP_URL / FRAMEOS_ACCOUNT_APP_URL /
// FRAMEOS_SCENES_APP_URL").
import { getAppOrigins } from "../../auth-web/src/lib/env";

// Development convenience mirroring Next's .env.local loading: walk up from
// the working directory and apply the first .env.local found (in local dev
// that is cloud/.env.local, written by scripts/db-setup.sh). Values already
// present in the environment are never overridden; production supplies env
// via the systemd unit's EnvironmentFile and never relies on this.
export function loadLocalEnv(startDir = process.cwd()): string | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 5; depth += 1) {
    const file = path.join(dir, ".env.local");
    if (existsSync(file)) {
      applyEnvFile(file);
      return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

function applyEnvFile(file: string) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = unquote(match[2] ?? "");
  }
}

function unquote(value: string) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if (
    (quote === '"' || quote === "'") &&
    trimmed.endsWith(quote) &&
    trimmed.length >= 2
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function getHubPort() {
  // An empty FRAME_HUB_PORT= line means "unset", not port 0 (Number("") is 0,
  // and port 0 would silently bind an ephemeral port nothing can reach).
  const raw = process.env.FRAME_HUB_PORT?.trim();
  if (!raw) {
    return 3100;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535
    ? parsed
    : 3100;
}

// Origins a browser WebSocket upgrade may come from. WS handshakes are not
// subject to CORS, so a cookie-authenticated socket is only safe as long as
// the Origin is checked here: today the session cookie is SameSite=Lax, but a
// split-domain `__Secure-` deployment would otherwise be open to cross-site
// hijacking of live fleet telemetry.
//
// The default is the set of FrameOS app origins auth-web mints its session
// cookie for; FRAME_HUB_ALLOWED_ORIGINS (comma separated) adds any extra
// origin a deployment fronts the hub with. Requests without an Origin header
// are not browsers (native clients, curl, the integration suite) and are
// judged by their credentials alone.
export function getAllowedBrowserOrigins(): Set<string> {
  const origins = new Set<string>();
  try {
    for (const origin of getAppOrigins()) {
      origins.add(origin);
    }
  } catch {
    // A malformed FRAMEOS_*_APP_URL must not take the hub down; the extra
    // origins below (or an empty allowlist, which rejects every browser
    // Origin) still apply.
  }
  for (const raw of (process.env.FRAME_HUB_ALLOWED_ORIGINS ?? "").split(",")) {
    const value = raw.trim();
    if (!value) {
      continue;
    }
    try {
      origins.add(new URL(value).origin);
    } catch {
      origins.add(value);
    }
  }
  return origins;
}

// Development cannot enumerate its own browser origins up front: `pnpm dev`
// is reached as http://localhost:3000, but also as http://<lan-ip>:3000 when
// the workspace is opened from a phone or a second machine on the network —
// and the FRAMEOS_*_APP_URL defaults only ever name localhost. So outside
// production the hub additionally accepts Origins whose host is loopback or
// private-network address space (the auth-web shell route points the fleet
// socket at http://<lan-ip>:3100 in exactly that case, and the dev session
// cookie — bare name, host-only, no Secure flag — is sent to the hub port on
// the same host). Never in production: docs/deployment.md's frame-hub.env
// sets NODE_ENV=production, and there the allowlist stays exactly the
// configured app origins plus FRAME_HUB_ALLOWED_ORIGINS.
export function allowsPrivateNetworkOrigins() {
  return process.env.NODE_ENV !== "production";
}

// Loopback plus RFC1918 and IPv4 link-local space — the hosts a dev machine
// is reachable as on its own LAN. Only complete IPv4 literals qualify (a
// prefix test would wave through the public hostname "10.4.evil.example");
// hostnames other than localhost are never matched, so a deployment behind a
// real name must be listed explicitly.
export function isPrivateNetworkHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "[::1]") {
    return true;
  }
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

export function isAllowedBrowserOrigin(
  origin: string | undefined,
  allowed: Set<string>,
  allowPrivateNetwork = false,
) {
  if (origin === undefined || origin === "") {
    return true;
  }
  // "null" is what a sandboxed iframe or a file:// page sends; never trust it.
  if (origin === "null") {
    return false;
  }
  try {
    const url = new URL(origin);
    if (allowed.has(url.origin)) {
      return true;
    }
    return (
      allowPrivateNetwork &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      isPrivateNetworkHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

// Hard ceiling on simultaneously attached sockets (devices + browsers), so an
// unauthenticated flood cannot exhaust file descriptors or heap. Sized for a
// fleet an order of magnitude larger than the single-host deployment expects.
export function getMaxConnections() {
  const parsed = Number(process.env.FRAME_HUB_MAX_CONNECTIONS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5000;
}
