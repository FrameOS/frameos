import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTestDatabaseUrl } from "./test-database-url";

// Force every environment value the hub reads so the suite is hermetic:
// DATABASE_URL always points at the dedicated test database (never a
// developer database from .env.local), and the secrets are deterministic.
process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.SESSION_SECRET = "frameos-cloud-frame-hub-integration-secret";

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
