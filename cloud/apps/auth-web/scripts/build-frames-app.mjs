// Rebuild the cloud frames SPA before the dev server copies it into public/.
//
// predev used to only COPY cloud-frontend/dist, so `pnpm dev` served whatever
// bundle happened to be lying around — shared-frontend fixes (frontend/src is
// the same code the backend UI ships) silently never reached the cloud until
// someone rebuilt by hand. That looked exactly like a forked codepath: the
// ESP32 metrics log line rendered "load 0 0 0 cpu 0.00°C" on cloud a day
// after the fix landed. Turbo makes this free: the cloud-frontend build task
// declares ../frontend/src/** as inputs, so an unchanged tree is a 30ms
// cache hit.
//
// Skipped when the package isn't installed (the production server ships
// prebuilt assets and has no workspace), mirroring copy-frames-app-assets.mjs.
/* global console, process */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(appDir, "package.json"));
try {
  require.resolve("@frameos/cloud-frontend/package.json");
} catch {
  console.log("@frameos/cloud-frontend not installed; keeping existing assets.");
  process.exit(0);
}

const result = spawnSync(
  "pnpm",
  ["-w", "exec", "turbo", "run", "build", "--filter=@frameos/cloud-frontend"],
  { cwd: appDir, stdio: "inherit" },
);
if (result.status !== 0) {
  console.error("cloud-frontend build failed; the frames SPA would be stale.");
  process.exit(result.status ?? 1);
}
