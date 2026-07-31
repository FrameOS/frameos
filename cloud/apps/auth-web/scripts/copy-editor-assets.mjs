// The frameos-editor bundle is built from this monorepo (frontend/dist-editor,
// snapshotted to frameos/editor/dist — run `pnpm editor:build` from cloud/),
// served as-is from public/ (gitignored), and embedded in an iframe — the
// iframe keeps the editor's global stylesheet and React 18 bundle isolated
// from this app. The modal talks to it over the documented postMessage
// protocol. See src/components/SceneEditorModal.tsx.
//
// When the monorepo build output is absent (CI, or the production server,
// where deploy.sh ships prebuilt assets inside the archive), existing assets
// in public/ are kept and nothing fails.
/* global console, process */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(appDir, "package.json"));
const editorDist = join(appDir, "..", "..", "..", "frameos", "editor", "dist");
const target = join(appDir, "public", "frameos-editor");

if (!existsSync(join(editorDist, "index.html"))) {
  if (existsSync(join(target, "index.html"))) {
    console.log(`No editor build at ${editorDist}; keeping existing assets in ${target}`);
  } else {
    console.warn(
      `No editor build at ${editorDist} and no existing assets in ${target}; ` +
        "the scene editor will not load. Run `pnpm editor:build` from cloud/ to build it.",
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
const wasmAssetsDir = dirname(require.resolve("frameos-wasm/assets/preview-worker.js"));
const wasmTarget = join(target, "frameos-wasm");
mkdirSync(wasmTarget, { recursive: true });
for (const file of ["frameos.js", "frameos.wasm", "preview-worker.js"]) {
  cpSync(join(wasmAssetsDir, file), join(wasmTarget, file));
}
console.log(`Copied frameos-editor assets (with frameos-wasm runtime) to ${target}`);
