// The cloud frames UI is the workspace package @frameos/cloud-frontend (the
// shared-frontend wrapper bundle at cloud-frontend/, built by `turbo build`),
// served as-is from public/frames-app (gitignored). The SPA shell is served
// for every /frames/** path by app/frames/[[...path]]/route.ts; the static
// assets load straight from /frames-app/. See cloud-frontend/README.md for
// the base-path contract.
//
// When the package's dist is absent (e.g. the production server, where the
// deploy ships prebuilt assets), existing assets in public/ are kept and
// nothing fails.
/* global console, process */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(appDir, "package.json"));
let framesAppDist = null;
try {
  framesAppDist = join(
    dirname(require.resolve("@frameos/cloud-frontend/package.json")),
    "dist",
  );
} catch {
  // Package not installed (e.g. production bundle) — fall through to the
  // keep-existing-assets path below.
}
const target = join(appDir, "public", "frames-app");

// An interrupted `cloud-frontend dev` (watch) run leaves a dist with an
// index.html but an empty static/ — build.mjs clears dist before esbuild's
// first emit. Copying that shell would serve a /frames page whose main.js
// 404s (and whose main.css comes back as Next's text/html 404 page, which
// strict MIME checking then refuses). Treat a shell whose referenced entry
// assets are missing as "not built".
function distIsComplete(dist) {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const referenced = [
    ...html.matchAll(/\/frames-app\/(static\/[^"']+\.(?:js|css))/g),
  ].map((match) => match[1]);
  if (referenced.length === 0) {
    console.warn(
      `Build at ${dist} references no /frames-app/static assets; ignoring it.`,
    );
    return false;
  }
  const missing = referenced.filter((file) => !existsSync(join(dist, file)));
  if (missing.length > 0) {
    console.warn(
      `Build at ${dist} is incomplete (index.html references ${missing.join(", ")} ` +
        "which do not exist — likely an interrupted watch build). " +
        "Re-run `turbo run build --filter=@frameos/cloud-frontend`.",
    );
    return false;
  }
  return true;
}

if (
  !framesAppDist ||
  !existsSync(join(framesAppDist, "index.html")) ||
  !distIsComplete(framesAppDist)
) {
  if (existsSync(join(target, "index.html")) && distIsComplete(target)) {
    console.log(
      `No cloud-frontend build at ${framesAppDist}; keeping existing assets in ${target}`,
    );
  } else {
    console.warn(
      `No cloud-frontend build at ${framesAppDist} and no existing assets in ${target}; ` +
        "the frames UI will not load. Run `turbo run build --filter=@frameos/cloud-frontend`.",
    );
  }
  process.exit(0);
}

rmSync(target, { force: true, recursive: true });
mkdirSync(target, { recursive: true });
cpSync(framesAppDist, target, { recursive: true });
console.log(`Copied @frameos/cloud-frontend assets to ${target}`);
