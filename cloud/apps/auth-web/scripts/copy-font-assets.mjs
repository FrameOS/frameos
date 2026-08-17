// The fonts FrameOS ships live in the repo (frameos/assets/copied/fonts) and
// are served by the cloud from public/fonts (gitignored): the font picker
// fetches them, and the per-frame font sync reads them off disk to push onto a
// card. Copied at build time rather than kept in the object store so a deploy
// can never be half-done — a manifest committed in git plus bytes that some
// seeding step forgot would 404 every font, and the bytes never change between
// releases anyway.
//
// src/generated/fonts.json is the catalogue (names, weights, sizes) and is
// generated separately by backend/scripts/generate_font_manifest.py, because
// parsing TTF name tables needs fontTools.
/* global console, process */
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(dirname(appDir)));
const sourceDir = join(repoRoot, "frameos", "assets", "copied", "fonts");
const target = join(appDir, "public", "fonts");
const manifestPath = join(appDir, "src", "generated", "fonts.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

mkdirSync(target, { recursive: true });
let copied = 0;
for (const font of manifest.fonts) {
  const source = join(sourceDir, font.file);
  // A font in the catalogue with no file behind it would serve a 404 to the
  // picker and fail every sync that reached it — fail the build instead.
  const size = statSync(source).size;
  if (size !== font.size) {
    throw new Error(
      `${font.file} is ${size} bytes but fonts.json says ${font.size} — ` +
        "regenerate it with backend/scripts/generate_font_manifest.py",
    );
  }
  copyFileSync(source, join(target, font.file));
  copied += 1;
}

console.log(
  `Copied ${copied} fonts (${(manifest.total_bytes / 1_000_000).toFixed(1)} MB) to ${target}`,
);
process.exitCode = 0;
