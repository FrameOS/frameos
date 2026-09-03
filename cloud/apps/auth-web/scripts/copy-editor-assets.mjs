// The frameos-editor bundle is the workspace package frameos/editor (built
// from frontend/dist-editor by `turbo build`), served as-is from public/
// (gitignored) and mounted directly into the page — no iframe — via its
// static/mount.js entry, which owns the editor's global stylesheet while
// open. See src/components/SceneEditorModal.tsx.
//
// When the package's dist is absent (e.g. the production server, where the
// deploy ships prebuilt assets), existing assets in public/ are kept and
// nothing fails.
/* global console, process */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeDir, runtimeFilesIn } from "./lib/wasm-runtime.mjs";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(appDir, "package.json"));
let editorDist = null;
try {
  editorDist = join(dirname(require.resolve("frameos-editor/package.json")), "dist");
} catch {
  // Package not installed (e.g. production bundle) — fall through to the
  // keep-existing-assets path below.
}
const target = join(appDir, "public", "frameos-editor");

if (!editorDist || !existsSync(join(editorDist, "index.html"))) {
  if (existsSync(join(target, "index.html"))) {
    console.log(`No editor build at ${editorDist}; keeping existing assets in ${target}`);
  } else {
    console.warn(
      `No editor build at ${editorDist} and no existing assets in ${target}; ` +
        "the scene editor will not load. Run `turbo run build --filter=frameos-editor`.",
    );
  }
  process.exit(0);
}

rmSync(target, { force: true, recursive: true });
mkdirSync(target, { recursive: true });
cpSync(editorDist, target, { recursive: true });

// The editor's built-in Preview panel loads the frameos-wasm runtime from
// ./frameos-wasm/ relative to its own directory (the bundle resolves asset
// URLs against its ingress path), so the runtime assets must sit next to it.
// Same source as copy-wasm-assets.mjs: the release's signed bundle, or the
// local build with FRAMEOS_WASM_SOURCE=local.
let wasmAssetsDir;
try {
  wasmAssetsDir = await resolveRuntimeDir();
} catch (error) {
  console.error(`frameos-wasm runtime: ${error.message}`);
  process.exit(1);
}
const wasmTarget = join(target, "frameos-wasm");
mkdirSync(wasmTarget, { recursive: true });
for (const file of runtimeFilesIn(wasmAssetsDir)) {
  cpSync(join(wasmAssetsDir, file), join(wasmTarget, file));
}
console.log(`Copied frameos-editor assets (with the frameos-wasm runtime) to ${target}`);
