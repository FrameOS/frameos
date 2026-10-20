import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTestDatabaseUrl } from "./test-database-url";

// Hermetic: the dedicated test database, deterministic secrets, a scratch
// object store, and no R2.
process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.SESSION_SECRET = "frameos-backend-provider-integration-secret";
process.env.FRAMEOS_OBJECT_STORE_DIR = mkdtempSync(join(tmpdir(), "frameos-backend-provider-objects-"));
delete process.env.R2_CLOUD_ENDPOINT;
delete process.env.R2_CLOUD_ACCESS_KEY_ID;
delete process.env.R2_CLOUD_SECRET_ACCESS_KEY;
delete process.env.R2_CLOUD_PUBLIC_BASE_URL;
