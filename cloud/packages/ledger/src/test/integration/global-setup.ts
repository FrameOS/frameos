import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { resolveTestDatabaseUrl } from "./test-database-url";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../db/drizzle",
);

// Build the test database from scratch on every run: create it if missing,
// then drop the public schema and replay all SQL migrations in order — the
// same discipline as auth-web's and the hub's integration setup. For the
// ledger it does double duty: the seeded chart of accounts and the
// append-only triggers the suite asserts on are things only the migration
// produces, so the tests are testing what production actually has.
export default async function globalSetup() {
  const databaseUrl = resolveTestDatabaseUrl();
  assertTestDatabaseName(databaseUrl);
  await ensureDatabaseExists(databaseUrl);

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const migrations = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of migrations) {
      await sql.unsafe(readFileSync(path.join(migrationsDir, name), "utf8"));
    }
  } finally {
    await sql.end();
  }
}

// The setup below drops the public schema of whatever database the URL
// names. A TEST_DATABASE_URL pointing at a development or production
// database would be wiped without a prompt, so the name has to say "test".
function assertTestDatabaseName(databaseUrl: string) {
  let databaseName = "";
  try {
    databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  } catch {
    // Fall through: an unparseable URL has no _test suffix either.
  }
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      `Refusing to run integration tests against database "${databaseName || databaseUrl}": ` +
        "the global setup drops its public schema, so the database name must end with _test.",
    );
  }
}

async function ensureDatabaseExists(databaseUrl: string) {
  const probe = postgres(databaseUrl, { max: 1 });
  try {
    await probe`select 1`;
    return;
  } catch (error) {
    if (!isMissingDatabaseError(error)) {
      throw connectionError(error, databaseUrl);
    }
  } finally {
    await probe.end();
  }

  const adminUrl = new URL(databaseUrl);
  const databaseName = adminUrl.pathname.replace(/^\//, "");
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

// Postgres error 3D000: invalid_catalog_name, i.e. the database does not
// exist yet. Anything else (server down, bad credentials) should fail loudly.
function isMissingDatabaseError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "3D000"
  );
}

function connectionError(error: unknown, databaseUrl: string) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `Could not connect to the integration test database at ${databaseUrl}: ${message}. ` +
      "Run `pnpm db:setup` to start the local Postgres, or point TEST_DATABASE_URL at a running server.",
  );
}
