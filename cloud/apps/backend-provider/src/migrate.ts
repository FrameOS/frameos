// The cloud's schema, applied to the sidecar's own Postgres at boot: the same
// files (cloud/packages/db/drizzle/*.sql), in the same order, recorded in the
// same `schema_migrations` ledger as cloud/scripts/db-migrate.sh — so the
// database a self-hosted backend carries is the cloud's, migration for
// migration, and the cloud's own tools can read it.
//
// Same atomicity rule as the script: each file runs in one transaction
// together with its ledger row, and a file whose first line is exactly
// `-- migrate: no-transaction` runs in autocommit with the row afterwards.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const noTransaction = /^--\s*migrate:\s*no-transaction\s*$/;

/** A file that opts out of the per-file transaction (its FIRST line says so). */
export function runsWithoutTransaction(text: string): boolean {
  return noTransaction.test(text.split("\n", 1)[0] ?? "");
}

export function defaultMigrationsDir(): string {
  const configured = process.env.FRAMEOS_PROVIDER_MIGRATIONS_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  // The repo layout (dev): cloud/apps/backend-provider -> cloud/packages/db.
  for (const candidate of [
    path.resolve(process.cwd(), "../../packages/db/drizzle"),
    path.resolve(process.cwd(), "cloud/packages/db/drizzle"),
    path.resolve(process.cwd(), "packages/db/drizzle"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("No migrations directory: set FRAMEOS_PROVIDER_MIGRATIONS_DIR");
}

export async function applyMigrations(
  databaseUrl: string,
  migrationsDir: string,
  log: (name: string) => void = () => undefined,
): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const applied: string[] = [];
  try {
    await sql.unsafe(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await sql<{ name: string }[]>`select name from schema_migrations`).map((row) => row.name),
    );
    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of files) {
      if (done.has(name)) {
        continue;
      }
      const text = readFileSync(path.join(migrationsDir, name), "utf8");
      if (runsWithoutTransaction(text)) {
        await sql.unsafe(text);
        await sql`insert into schema_migrations (name) values (${name})`;
      } else {
        await sql.begin(async (tx) => {
          await tx.unsafe(text);
          await tx`insert into schema_migrations (name) values (${name})`;
        });
      }
      applied.push(name);
      log(name);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return applied;
}
