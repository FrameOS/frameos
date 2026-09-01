import { defineConfig } from "vitest/config";

// The kernel's real subject is Postgres: idempotent inserts, balance upserts
// under concurrency, and the append-only triggers. Those are integration
// tests against a real database; see src/test/integration/test-database-url.ts
// for how it is chosen. `pnpm test` runs the pure unit tests instead.
export default defineConfig({
  test: {
    environment: "node",
    // All files share one database; keep them sequential so truncation in one
    // file cannot race tests in another.
    fileParallelism: false,
    globalSetup: ["src/test/integration/global-setup.ts"],
    hookTimeout: 30_000,
    include: ["src/test/integration/**/*.integration.test.ts"],
    testTimeout: 30_000,
  },
});
