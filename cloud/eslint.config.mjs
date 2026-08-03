import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.next/**",
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
      // Copied frameos-wasm/frameos-editor/cloud-frontend assets
      // (see copy-*-assets.mjs).
      "**/public/frameos-wasm/**",
      "**/public/frameos-editor/**",
      "**/public/frames-app/**",
      "pnpm-lock.yaml",
      // Renders the legacy workspace's FrameActionsMenu; its import graph
      // (frontend/src) predates auth-web's strict compiler options, so the
      // file is excluded from that tsconfig — which typed linting requires.
      // Vitest still runs it.
      "**/src/test/shared-spa/esp32-frame-controls.test.tsx",
      // Same exclusion, same reason: mounts the real framesModel, whose
      // import graph reaches the legacy workspace components.
      "**/src/test/shared-spa/cloud-scene-deploy.test.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
);
