import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { applyMigrations } from "../../migrate";
import { resolveTestDatabaseUrl } from "./test-database-url";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../packages/db/drizzle",
);

// Build the test database from scratch on every run with the sidecar's own
// migration runner (src/migrate.ts) — the code that builds a backend's
// database at boot, so the suite runs against exactly what it produces.
export default async function globalSetup() {
  const databaseUrl = resolveTestDatabaseUrl();
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!databaseName.endsWith("_test")) {
    throw new Error(`Refusing to reset database "${databaseName}": its name must end with _test.`);
  }
  const admin = new URL(databaseUrl);
  admin.pathname = "/postgres";
  const adminSql = postgres(admin.toString(), { max: 1, onnotice: () => undefined });
  try {
    const exists = await adminSql`select 1 from pg_database where datname = ${databaseName}`;
    if (exists.length === 0) {
      await adminSql.unsafe(`CREATE DATABASE "${databaseName}"`);
    }
  } finally {
    await adminSql.end();
  }
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await sql.end();
  }
  await applyMigrations(databaseUrl, migrationsDir);
}
