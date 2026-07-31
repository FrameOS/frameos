#!/usr/bin/env node
/* global console, process */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? process.env.NODE_ENV ?? "development";

const envFiles = [
  `.env.${mode}.local`,
  mode === "test" ? undefined : ".env.local",
  `.env.${mode}`,
  ".env",
].filter(Boolean);

const databaseUrl = configuredDatabaseUrl();

if (!databaseUrl) {
  console.error(
    [
      "DATABASE_URL is required before starting FrameOS Cloud auth-web.",
      "Run `pnpm db:setup` from the repository root or configure DATABASE_URL.",
    ].join("\n"),
  );
  process.exit(1);
}

function configuredDatabaseUrl() {
  if (process.env.DATABASE_URL !== undefined) {
    return process.env.DATABASE_URL.trim();
  }

  for (const envFile of envFiles) {
    const value = readDatabaseUrl(resolve(appDir, envFile));
    if (value !== undefined) {
      return value.trim();
    }
  }

  return "";
}

function readDatabaseUrl(path) {
  if (!existsSync(path)) {
    return undefined;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/);
    if (match) {
      return unquoteEnvValue(match[1]);
    }
  }

  return undefined;
}

function unquoteEnvValue(value) {
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
