// The integration suite runs against a dedicated database so it can freely
// truncate tables without touching development data — and a different one
// from auth-web's (frameos_cloud_test) so both suites can run side by side.
// By default it targets the local Postgres started by `pnpm db:setup`
// (scripts/db-setup.sh) on port 55432; the global setup creates the database
// on demand.
export function resolveTestDatabaseUrl() {
  const explicit = process.env.TEST_DATABASE_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const port = process.env.FRAMEOS_CLOUD_PGPORT?.trim() || "55432";
  return `postgres://frameos_cloud@127.0.0.1:${port}/frameos_cloud_frame_hub_test`;
}
