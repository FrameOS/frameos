// The integration suite runs against a dedicated database so it can freely
// truncate tables without touching development data. By default it targets the
// local Postgres started by `pnpm db:setup` (scripts/db-setup.sh) on port
// 55432, in a separate `frameos_cloud_test` database that the global setup
// creates on demand.
export function resolveTestDatabaseUrl() {
  const explicit = process.env.TEST_DATABASE_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const port = process.env.FRAMEOS_CLOUD_PGPORT?.trim() || "55432";
  return `postgres://frameos_cloud@127.0.0.1:${port}/frameos_cloud_test`;
}
