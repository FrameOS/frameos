import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
  const parsed = Number(process.env.FRAME_HUB_PORT);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535
    ? parsed
    : 3100;
}
