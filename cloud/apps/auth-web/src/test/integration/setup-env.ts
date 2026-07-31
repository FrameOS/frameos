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
