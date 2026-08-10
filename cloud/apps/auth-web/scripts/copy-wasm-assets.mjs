// The frameos-wasm runtime runs in a Web Worker and must be served
// same-origin: copy its assets out of node_modules into public/ (gitignored)
// before dev/build. See src/components/SceneLivePreview.tsx.
/* global console */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(appDir, "package.json"));
const assetsDir = dirname(require.resolve("frameos-wasm/assets/preview-worker.js"));
const target = join(appDir, "public", "frameos-wasm");

mkdirSync(target, { recursive: true });
for (const file of ["frameos.js", "frameos.wasm", "preview-worker.js"]) {
  copyFileSync(join(assetsDir, file), join(target, file));
}
console.log(`Copied frameos-wasm assets to ${target}`);
