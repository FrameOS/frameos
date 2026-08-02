// Serve the standalone frame installer (scripts/frameos-setup.sh at the repo
// root — the same script frameos.net publishes as setup.sh) from this origin
// as /install.sh, so the "Add frame" install-script tile works against any
// provider, including self-hosted ones. Copied at build time; on the
// production server (where the repo checkout is absent) the copy shipped in
// the deploy bundle is kept.
/* global console */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(appDir, "..", "..", "..", "scripts", "frameos-setup.sh");
const target = join(appDir, "public", "install.sh");

if (!existsSync(source)) {
  if (existsSync(target)) {
    console.log(`No repo installer at ${source}; keeping existing ${target}`);
  } else {
    console.warn(
      `No repo installer at ${source} and no existing ${target}; /install.sh will 404.`,
    );
  }
} else {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`Copied ${source} -> ${target}`);
}
