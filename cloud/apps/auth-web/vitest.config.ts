import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Browser-only ESM with no node entry: shared-spa tests that import a
      // frontend logic touching Monaco (editAppLogic) get this stub instead.
      "monaco-editor": fileURLToPath(new URL("./src/test/stubs/monaco-editor.ts", import.meta.url)),
    },
  },
  // The app tsconfig uses Next's "jsx": "preserve"; vitest (esbuild)
  // needs to be told to compile JSX itself.
  esbuild: { jsx: "automatic" },
  test: {
    // Library tests run in node; component tests opt into jsdom with a
    // `// @vitest-environment jsdom` docblock.
    environment: "node",
    // Integration tests need a Postgres database and run separately via
    // `pnpm test:integration` (vitest.integration.config.ts).
    //
    // .next is excluded because `next build` copies the whole source tree —
    // test files included — into .next/standalone. Collected from there they
    // fail on a tsconfig that no longer resolves its `extends`, so running the
    // suite after a build reported 85 failed files and 0 failed tests.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts", "**/.next/**"],
    // Scrubs environment the CI workflow exports for the build step (the
    // PostHog key) so tests only see values they set themselves.
    setupFiles: ["src/test/setup-env.ts"],
  },
});
