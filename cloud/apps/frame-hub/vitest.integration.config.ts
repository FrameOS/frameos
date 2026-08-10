import { defineConfig } from "vitest/config";

// Integration tests run the real hub (HTTP server + WebSockets) against a real
// Postgres database. Run with `pnpm test:integration`; see
// src/test/integration/test-database-url.ts for how the database is chosen.
export default defineConfig({
  test: {
    environment: "node",
    // All files share one database; keep them sequential so truncation in one
    // file cannot race tests in another.
    fileParallelism: false,
    globalSetup: ["src/test/integration/global-setup.ts"],
    hookTimeout: 30_000,
    include: ["src/test/integration/**/*.integration.test.ts"],
    setupFiles: ["src/test/integration/setup-env.ts"],
    testTimeout: 30_000,
  },
});
