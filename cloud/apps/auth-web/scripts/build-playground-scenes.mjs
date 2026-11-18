// The scenes the playground (playground.frameos.net, cloud/docs/playground.md)
// boots with: its own Welcome (playground-scenes/, here and nowhere else), then
// the repo's sample and gallery scenes, every layout among them, written to
// public/playground-assets/scenes.json (gitignored) before dev/build. Read from
// repo/scenes at build time, so a sample added to the repo reaches the
// playground with the next cloud deploy.
/* global console, process */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(dirname(appDir)));
const scenesRoot = join(repoRoot, "repo", "scenes");
// Scenes about the playground itself, which would be wrong on a frame: not in
// repo/scenes, whose every template also reaches frames and the AI's catalog.
const playgroundRoot = join(appDir, "playground-scenes");
const target = join(appDir, "public", "playground-assets", "scenes.json");

// Samples that cannot run in a browser tab nobody configured: they need an
// API key or an account in the frame's settings, or a process on a Pi.
export const excludedTemplates = new Set([
  "Bird field journal",
  "Chromium Screenshot",
  "Google Photos",
  "Haiku of the hour",
  "Home Assistant remote",
  "Homey remote",
  "Immich",
  "MiniGPT",
  "OpenAI image",
  "Unsplash image",
  "Webcam RSTP",
]);

// The Start menu lists the scenes in this order, then the rest by name. The
// first is the one the desktop opens on.
export const leadingTemplates = [
  "Welcome",
  "Scene store",
  "Pixel toys",
  "Color cycling",
  "Kitchen sink",
  "Form showcase",
  "Map",
  "Now playing",
  "To-do",
  "Colors",
  "Calculator",
  "Home",
  "Clock",
  "Weather demo",
  "Steps",
  "Gallery",
  "Tap counter",
  "DVD Logo Bounce",
  "Analog clock face",
  "Weather",
  "Word clock",
  "Terminal app",
  "Files",
  "Theme roles",
];

export const playgroundLayoutId = "layout-windows-98";

function templatesIn(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ dir: join(dir, entry.name), name: entry.name }));
}

export function playgroundScenes() {
  const templates = [
    ...templatesIn(playgroundRoot),
    ...templatesIn(join(scenesRoot, "samples")),
    ...templatesIn(join(scenesRoot, "gallery")),
  ].filter(
    (template) => !excludedTemplates.has(template.name),
  );
  const rank = (name) => {
    const index = leadingTemplates.indexOf(name);
    return index === -1 ? leadingTemplates.length : index;
  };
  templates.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));

  const scenes = [];
  const seen = new Set();
  for (const template of templates) {
    const meta = JSON.parse(readFileSync(join(template.dir, "template.json"), "utf8"));
    const file = join(template.dir, String(meta.scenes ?? "./scenes.json"));
    for (const scene of JSON.parse(readFileSync(file, "utf8"))) {
      if (!scene?.id || seen.has(scene.id)) {
        throw new Error(`${template.name}: scene id ${scene?.id ?? "(none)"} missing or repeated`);
      }
      seen.add(scene.id);
      scenes.push(scene);
    }
  }
  if (!seen.has(playgroundLayoutId)) {
    throw new Error(`the playground's layout ${playgroundLayoutId} is not among the scenes`);
  }
  return scenes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const scenes = playgroundScenes();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(scenes));
    console.log(`Wrote ${scenes.length} playground scenes into ${target}`);
  } catch (error) {
    console.error(`playground scenes: ${error.message}`);
    process.exit(1);
  }
}
