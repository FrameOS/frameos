import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTestDatabaseUrl } from "./test-database-url";

// Force every environment value the route handlers read so the suite is
// hermetic: DATABASE_URL always points at the dedicated test database (never a
// developer database loaded from .env.local), and the secrets are
// deterministic.
process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.FRAMEOS_CLOUD_APP_URL = "http://localhost:3000";
process.env.FRAMEOS_ACCOUNT_APP_URL = "http://localhost:3000";
process.env.FRAMEOS_SCENES_APP_URL = "http://localhost:3000";
delete process.env.FRAMEOS_SESSION_COOKIE_DOMAIN;
process.env.FRAMEOS_CLOUD_ENCRYPTION_KEY = Buffer.from(
  "integration-test-encryption-key!",
).toString("base64");
process.env.SESSION_SECRET = "frameos-cloud-integration-test-session-secret";
// Signup notifications must stay dormant: with these unset, signup routes
// never reach out to PostHog during the suite.
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.NEXT_PUBLIC_POSTHOG_HOST;

// Blobs live in object storage now (src/lib/object-store.ts). Point the
// filesystem driver at a scratch directory per run so the suite never writes
// into a developer's db/object-storage, and so a stale object from an earlier
// run cannot make a test pass.
process.env.FRAMEOS_OBJECT_STORE_DIR = mkdtempSync(
  join(tmpdir(), "frameos-cloud-test-objects-"),
);
delete process.env.R2_CLOUD_ENDPOINT;
delete process.env.R2_CLOUD_ACCESS_KEY_ID;
delete process.env.R2_CLOUD_SECRET_ACCESS_KEY;
delete process.env.R2_CLOUD_PUBLIC_BASE_URL;
