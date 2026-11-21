import { strFromU8, strToU8, zipSync } from "fflate";
import {
  packageRoot,
  setFromPackageFiles,
  setPackageFiles,
} from "../../../../../frontend/src/utils/scenePackage";
import { unzipBounded } from "./zip-bounded";

// The template interchange zip (docs/scene-packages.md): template.json, the
// cover (image.jpg) and a folder per scene holding its scene.json and its
// apps' files, apps/<keyword>/<file>. Every version the store writes is laid
// out so; a version from before packages (template.json naming a scenes.json
// with the whole array) is read the same way and stays as it is (versions are
// immutable). A self-hosted backend from before packages reads only the old
// form: what it fetches is `templateZipLegacyBytes` (the download route's
// ?layout=json, which the store page's frameos:zip tag names).

/** The entries a template zip is read for: the manifest, the scenes (whole
 * in a legacy scenes.json, or scene folders) and the cover. */
export function isTemplateZipEntry(name: string): boolean {
  return /(^|\/)(template\.json|scenes\.json|scene\.json|image\.jpg)$|(^|\/)apps\//.test(name);
}

export type TemplateZip = {
  /** Where everything is: `""` or `"<name>/"`. */
  folder: string;
  manifest: Record<string, unknown>;
  /** null: a zip of scenes without a template.json (read, but no template). */
  manifestPath: string | null;
  scenes: unknown[];
  /** The scenes' bytes as text in the zip, for bounding what is built from them. */
  sceneBytes: number;
  image: Uint8Array | undefined;
};

function depth(path: string): number {
  return path.split("/").length - 1;
}

/** A template zip's manifest, scenes and cover, whichever form its scenes
 * are in; undefined when its template.json is deeper than one folder, its
 * scenes cannot be read, or a bound is exceeded. A zip without a
 * template.json (scenes alone) reads with `manifestPath` null. */
export function readTemplateZip(zip: Uint8Array): TemplateZip | undefined {
  try {
    const files = unzipBounded(zip, isTemplateZipEntry);
    const manifestPath =
      Object.keys(files)
        .filter((name) => /(^|\/)template\.json$/.test(name))
        .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0] ?? null;
    if (manifestPath && depth(manifestPath) > 1) {
      return undefined;
    }
    const root = manifestPath
      ? manifestPath.slice(0, manifestPath.length - "template.json".length)
      : packageRoot(Object.keys(files).filter((name) => !/(^|\/)image\.jpg$/.test(name)));
    const folder = root && !root.endsWith("/") ? `${root}/` : root;
    const texts: Record<string, string> = {};
    let sceneBytes = 0;
    for (const [name, data] of Object.entries(files)) {
      if (/(^|\/)image\.jpg$/.test(name) || !name.startsWith(folder)) {
        continue;
      }
      texts[name.slice(folder.length)] = strFromU8(data);
      if (!name.endsWith("template.json")) {
        sceneBytes += data.length;
      }
    }
    const read = setFromPackageFiles(texts, "");
    return {
      folder,
      image: files[`${folder}image.jpg`],
      manifest: read.manifest ?? {},
      manifestPath,
      sceneBytes,
      scenes: read.scenes,
    };
  } catch {
    return undefined;
  }
}

/** The scenes of a template zip, or undefined (see readTemplateZip). */
export function templateZipScenes(zip: Uint8Array | Buffer): unknown[] | undefined {
  return readTemplateZip(new Uint8Array(zip))?.scenes;
}

function withoutScenesKey(manifest: Record<string, unknown>): Record<string, unknown> {
  const { scenes: _scenes, ...rest } = manifest;
  return rest;
}

/** A template zip, laid out as scene packages under `folder` ("" or
 * "<name>/"): template.json is `manifest` with `scenes` the folders. */
export function templateZipBytes(
  folder: string,
  manifest: Record<string, unknown>,
  scenes: unknown[],
  image?: Uint8Array,
): Buffer {
  const next: Record<string, Uint8Array> = {};
  const files = setPackageFiles(scenes as Record<string, unknown>[], withoutScenesKey(manifest));
  for (const [path, text] of Object.entries(files)) {
    next[`${folder}${path}`] = strToU8(text);
  }
  if (image) {
    // The interchange format knows one cover path; the real raster format
    // is sniffed from the bytes wherever it is read.
    next[`${folder}image.jpg`] = image;
  }
  return Buffer.from(zipSync(next));
}

/** The same zip in the form before packages, for a backend that reads only
 * that: template.json naming a scenes.json that holds the whole array. */
export function templateZipLegacyBytes(
  folder: string,
  manifest: Record<string, unknown>,
  scenes: unknown[],
  image?: Uint8Array,
): Buffer {
  const next: Record<string, Uint8Array> = {
    [`${folder}template.json`]: strToU8(
      JSON.stringify({ ...withoutScenesKey(manifest), scenes: "./scenes.json" }, null, 2),
    ),
    [`${folder}scenes.json`]: strToU8(JSON.stringify(scenes, null, 2)),
  };
  if (image) {
    next[`${folder}image.jpg`] = image;
  }
  return Buffer.from(zipSync(next));
}
