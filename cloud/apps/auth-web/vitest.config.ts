import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // The app tsconfig uses Next's "jsx": "preserve"; vitest (rolldown-vite)
  // needs to be told to compile JSX itself.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // Library tests run in node; component tests opt into jsdom with a
    // `// @vitest-environment jsdom` docblock.
    environment: "node",
    // Integration tests need a Postgres database and run separately via
    // `pnpm test:integration` (vitest.integration.config.ts).
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});
