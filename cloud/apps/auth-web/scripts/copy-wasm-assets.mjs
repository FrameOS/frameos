// The frameos-wasm runtime runs in a Web Worker and must be served
// same-origin: install it into public/frameos-wasm (gitignored) before
// dev/build. See src/components/SceneLivePreview.tsx.
//
// Where it comes from is lib/wasm-runtime.mjs's business: by default the
// signed, version-pinned bundle from the FrameOS release (so the preview
// renders with the interpreter frames actually run), or the workspace
// package's own build with FRAMEOS_WASM_SOURCE=local.
/* global console, process */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeDir, runtimeFilesIn } from "./lib/wasm-runtime.mjs";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(appDir, "public", "frameos-wasm");

try {
  const source = await resolveRuntimeDir();
  mkdirSync(target, { recursive: true });
  for (const file of runtimeFilesIn(source)) {
    copyFileSync(join(source, file), join(target, file));
  }
  console.log(`Installed the frameos-wasm runtime into ${target}`);
} catch (error) {
  console.error(`frameos-wasm runtime: ${error.message}`);
  process.exit(1);
}
