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
      // Imports frontend/src/utils/duplicateScenes, excluded from the
      // package tsconfig for its pre-strict FrameEvent typing; the project
      // service therefore cannot parse it. Vitest still runs it.
      "**/src/test/shared-spa/duplicate-scenes.test.ts",
      "**/src/test/shared-spa/frame-secrets-mirror.test.ts",
      // Same exclusion, same reason: mounts the real framesModel, whose
      // import graph reaches the legacy workspace components.
      "**/src/test/shared-spa/cloud-scene-deploy.test.ts",
      // Same exclusion, same reason: renders the whole deploy drawer.
      "**/src/test/shared-spa/cloud-deploy-dialog.test.tsx",
      // Same exclusion, same reason: mounts EmbeddedWebFlasher.
      "**/src/test/shared-spa/embedded-flash-shared.test.ts",
      // Same exclusion, same reason: mounts EmbeddedReleaseFlasher.
      "**/src/test/shared-spa/embedded-release-flasher.test.tsx",
      // The USB board classifier type-imports embeddedUsbLogsModel; the
      // scene-execution corpus runner imports frameDeployUtils. Both are in
      // the tsconfig exclude for the same strict-compiler reason.
      "**/src/test/shared-spa/usb-board-identity.test.ts",
      "**/src/test/shared-spa/scene-execution-fixtures.test.ts",
      // Same exclusion, same reason: imports frameLogic, whose graph reaches
      // the legacy workspace components.
      "**/src/test/shared-spa/frame-change-value.test.ts",
      // Same exclusion, same reason: builds every logic the embedded editor
      // mounts; workspaceLogic reaches the legacy workspace components.
      "**/src/test/shared-spa/embedded-editor-logics.test.ts",
      "**/src/test/shared-spa/scene-state-logic.test.ts",
      // Same exclusion, same reason: frameStatusGroups's import graph
      // reaches decorators/frame.tsx and the legacy components.
      "**/src/test/shared-spa/frame-status-groups.test.ts",
      "**/src/test/shared-spa/frame-checkin.test.ts",
      // Same exclusion, same reason: devices.ts reaches components/Select.tsx.
      "**/src/test/shared-spa/device-catalog-mirror.test.ts",
      // Same exclusion, same reason: importing frameLogic pulls in
      // framesModel and the decorators behind it.
      "**/src/test/shared-spa/cloud-frame-change-details.test.ts",
      // Same exclusion, same reason: mounts framesModel itself.
      "**/src/test/shared-spa/cloud-frame-scenes-loading.test.ts",
      // Same exclusion, same reason: imports frameLogic's sanitizeScene.
      "**/src/test/shared-spa/cloud-scene-persist-equality.test.ts",
      "**/src/test/shared-spa/scene-origin.test.ts",
      // Same exclusion, same reason: sanitizeIncomingScenes is a thin wrapper
      // over that same sanitizeScene.
      "**/src/test/shared-spa/embedded-editor-scene-sanitize.test.ts",
      // Same exclusion, same reason from the other direction: it imports
      // metricsLogic, whose RebootMarker literals spell optional fields as
      // `undefined`.
      "**/src/test/shared-spa/battery-misreads.test.ts",
      // Same exclusion, same reason: chartData takes its types from
      // metricsLogic, and BrushChart draws chartData's output.
      "**/src/test/shared-spa/metrics-chart-data.test.ts",
      "**/src/test/shared-spa/metrics-brush-chart.test.tsx",
      // Same exclusion, same reason, widest graph of the lot: mounts the
      // whole FrameSettings panel and the colour picker behind it.
      "**/src/test/shared-spa/cloud-frame-settings-panel.test.tsx",
      // Same exclusion, same reason: imports frameLogic.
      "**/src/test/shared-spa/frame-service-keys-change.test.ts",
      // Same exclusion, same reason: diagramLogic against the embed shim,
      // and export helpers that reach frameLogic / duplicateScenes.
      "**/src/test/shared-spa/diagram-history.test.ts",
      "**/src/test/shared-spa/editor-export-secrets.test.ts",
      "**/src/test/shared-spa/preview-key-consent.test.ts",
      // The scene-editor logic tests (2026-09 review §11), same reason.
      "**/src/test/shared-spa/diagram-clipboard.test.ts",
      "**/src/test/shared-spa/new-node-picker.test.ts",
      "**/src/test/shared-spa/markdown-safety.test.tsx",
      "**/src/test/shared-spa/monaco-paths.test.ts",
      "**/src/test/shared-spa/app-node-logic.test.ts",
      "**/src/test/shared-spa/scene-json-logic.test.ts",
      "**/src/test/shared-spa/select-options.test.ts",
      "**/src/test/shared-spa/select-missing-value.test.tsx",
      // The store error-code wording (2026-09 review §2), same reason.
      "**/src/test/shared-spa/store-scene-errors.test.ts",
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
