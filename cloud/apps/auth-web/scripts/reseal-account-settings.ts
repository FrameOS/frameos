/* global console */
// One-off: re-seal the account_settings rows that still hold a legacy
// plaintext secret (written before sealing shipped; src/lib/account-settings.ts
// "Secrets at rest"). The read path re-seals a row the first time it is read,
// so what is left are the rows of accounts that have not opened their settings
// or used a frame or the AI since — and those would stay plaintext in every
// database dump and backup until they do. No SQL migration can do this: the
// encryption key is not in Postgres, so run it where auth-web's environment is
// (FRAMEOS_CLOUD_ENCRYPTION_KEY and DATABASE_URL, e.g. auth-web.env).
//
// Safe to re-run: a sealed row is left alone, and so is a row saved between
// this script's read and its write.
//
// DRY RUN BY DEFAULT — pass --apply to write.
//
//   DATABASE_URL=... FRAMEOS_CLOUD_ENCRYPTION_KEY=... \
//     pnpm --filter @frameos-cloud/auth-web settings:reseal-legacy [--apply]
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { createDb } from "@frameos-cloud/db";
import { resealLegacyAccountSettings } from "../src/lib/account-settings";

function loadEnv(): void {
  for (const candidate of [resolve(process.cwd(), ".env.local"), resolve(process.cwd(), "../../.env.local")]) {
    if (existsSync(candidate)) {
      try {
        (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.call(process, candidate);
      } catch {
        // tolerate a malformed line
      }
      break;
    }
  }
}

async function main(): Promise<void> {
  loadEnv();
  const apply = process.argv.slice(2).includes("--apply");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!process.env.FRAMEOS_CLOUD_ENCRYPTION_KEY) {
    throw new Error("FRAMEOS_CLOUD_ENCRYPTION_KEY is not set");
  }
  const db = createDb(databaseUrl);
  try {
    const found = await resealLegacyAccountSettings(db, { apply });
    for (const row of found) {
      console.log(`- account ${row.accountId}: ${row.key}`);
    }
    console.log(
      `${found.length} row(s) with a plaintext secret${apply ? " re-sealed" : "; dry run, pass --apply to re-seal"}.`,
    );
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
