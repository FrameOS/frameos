import { resolveTestDatabaseUrl } from "./test-database-url";

// Force every environment value the hub reads so the suite is hermetic:
// DATABASE_URL always points at the dedicated test database (never a
// developer database from .env.local), and the secrets are deterministic.
process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.SESSION_SECRET = "frameos-cloud-frame-hub-integration-secret";
