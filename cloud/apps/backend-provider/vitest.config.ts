import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Integration tests need a Postgres database and run separately via
    // `pnpm test:integration` (vitest.integration.config.ts).
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});
