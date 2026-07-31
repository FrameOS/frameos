// The frameos-editor bundle (AGPL) is served as-is from public/ (gitignored)
// and embedded in an iframe; its code is never imported into this app's
// bundle — the modal talks to it over the documented postMessage protocol.
// See src/components/SceneEditorModal.tsx.
/* global console */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(appDir, "package.json"));
const packageDir = dirname(require.resolve("frameos-editor/package.json"));
const target = join(appDir, "public", "frameos-editor");

rmSync(target, { force: true, recursive: true });
mkdirSync(target, { recursive: true });
cpSync(join(packageDir, "dist"), target, { recursive: true });

// The editor's built-in Preview panel loads the frameos-wasm runtime from
// ./frameos-wasm/ relative to its own directory (the bundle resolves asset
// URLs against its ingress path), so the runtime assets must sit next to it.
const wasmAssetsDir = dirname(require.resolve("frameos-wasm/assets/preview-worker.js"));
const wasmTarget = join(target, "frameos-wasm");
mkdirSync(wasmTarget, { recursive: true });
for (const file of ["frameos.js", "frameos.wasm", "preview-worker.js"]) {
  cpSync(join(wasmAssetsDir, file), join(wasmTarget, file));
}
console.log(`Copied frameos-editor assets (with frameos-wasm runtime) to ${target}`);
