import { configDefaults, defineConfig } from "vitest/config";

// Unit tests only: the chart, the money parsing and the posting rules, none
// of which touch a database. The kernel's tests need a real Postgres and run
// separately via `pnpm test:integration` (vitest.integration.config.ts).
export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});
