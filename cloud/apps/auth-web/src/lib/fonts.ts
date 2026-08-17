// The font catalogue FrameOS Cloud offers.
//
// A self-hosted backend answers /api/fonts with the fonts checked into
// `frameos/assets/copied/fonts` plus whatever the project uploaded. The cloud
// has no project asset store, so it offers the checked-in set only — the same
// faces, the same metadata, generated into src/generated/fonts.json by
// backend/scripts/generate_font_manifest.py (TTF name tables need fontTools,
// which is a Python dependency and not a Node one).
//
// The bytes are served from public/fonts, copied there at build time by
// scripts/copy-font-assets.mjs.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import manifest from "../generated/fonts.json";

/** Exactly the fields the shared SPA's FontMetadata type carries. */
export type FontMetadata = {
  file: string;
  name: string;
  weight: number;
  weight_title: string;
  italic: boolean;
};

export type CatalogueFont = FontMetadata & {
  /** Byte size on disk — what the sync loop compares against a frame's listing. */
  size: number;
};

export const catalogueFonts: CatalogueFont[] = manifest.fonts;

export const catalogueTotalBytes: number = manifest.total_bytes;

/** The metadata the font picker asks for, without the sync loop's `size`. */
export function fontListResponse(): { fonts: FontMetadata[] } {
  return {
    fonts: catalogueFonts.map(({ file, italic, name, weight, weight_title }) => ({
      file,
      italic,
      name,
      weight,
      weight_title,
    })),
  };
}

/**
 * Look a font up by filename. Returning the manifest entry rather than
 * validating a path is the point: a name that is not in the catalogue never
 * becomes a filesystem path, so there is no traversal to defend against.
 */
export function catalogueFont(file: string): CatalogueFont | undefined {
  return catalogueFonts.find((font) => font.file === file);
}

/**
 * The bytes of a catalogued font, for pushing onto a frame.
 *
 * public/fonts is where the build puts them and where a deploy has them. The
 * repo folder is the fallback that makes `vitest` and a bare `next dev` work
 * without having run the copy script first — it is the same file either way,
 * and only a name already in the catalogue ever gets this far.
 */
export async function readCatalogueFont(font: CatalogueFont): Promise<Buffer> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "public", "fonts", font.file),
    // src/lib -> src -> app root -> apps -> cloud -> repo root
    join(here, "..", "..", "..", "..", "..", "frameos", "assets", "copied", "fonts", font.file),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Font ${font.file} is in the catalogue but readable at neither ${candidates.join(" nor ")}: ` +
      `${String(lastError)}`,
  );
}
