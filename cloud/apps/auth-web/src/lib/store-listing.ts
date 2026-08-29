import { and, eq, sql } from "drizzle-orm";
import {
  storeImages,
  storeSceneVersionImages,
  storeSceneVersions,
  storeScenes,
} from "@frameos-cloud/db";
import { normalizeCategory } from "./categories";
import { moderateStoreContent } from "./moderation";
import { normalizeFrameosVersion, normalizeTags } from "./store";

// The listing: what the store page says about a scene besides its content.
// It is versioned — each store_scene_versions row records the listing it
// was published with, and the zip's template.json carries the same fields
// — while the store_scenes columns of the same names hold the listing of
// the latest version, the projection the store's SQL filters and searches
// on. Visibility, status and the like are not listing: they are access
// control and moderation, and stay on the row alone.

export const maxSceneDescriptionChars = 2000;

export type SceneListing = {
  category: string | null;
  description: string | null;
  frameosVersion: string | null;
  tags: string[];
};

/** A partial listing: the fields an edit names. */
export type ListingChanges = Partial<SceneListing>;

export const emptyListing: SceneListing = {
  category: null,
  description: null,
  frameosVersion: null,
  tags: [],
};

/** The listing to show for a version. Versions published before listings
 * were recorded per version (listingRecorded false) fall back to the scene
 * row — the latest listing — which is also what the latest version shows,
 * since the row is where moderators' category edits land. */
export function listingForVersion(
  version: {
    category: string | null;
    description: string | null;
    frameosVersion: string | null;
    listingRecorded: boolean;
    tags: string[];
    version: number;
  },
  scene: SceneListing & { latestVersion: number },
): SceneListing {
  if (!version.listingRecorded || version.version === scene.latestVersion) {
    return {
      category: scene.category,
      description: scene.description,
      // Versions always recorded their own minimum FrameOS version.
      frameosVersion:
        version.version === scene.latestVersion
          ? scene.frameosVersion
          : version.frameosVersion,
      tags: scene.tags,
    };
  }
  return {
    category: version.category,
    description: version.description,
    frameosVersion: version.frameosVersion,
    tags: version.tags,
  };
}

export function listingEquals(a: SceneListing, b: SceneListing): boolean {
  return (
    (a.description ?? null) === (b.description ?? null) &&
    (a.category ?? null) === (b.category ?? null) &&
    (a.frameosVersion ?? null) === (b.frameosVersion ?? null) &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index])
  );
}

/** Reads the listing fields out of a request body or a tool's arguments. A
 * field left out of the input is left out of the changes: only what was
 * named is edited. Returns the API's own error code when one of them is
 * malformed, so every caller refuses it with the same word. */
export function parseListingChanges(
  input: Record<string, unknown>,
): { changes: ListingChanges } | { error: string } {
  const changes: ListingChanges = {};

  if (typeof input.description === "string" || input.description === null) {
    const trimmed =
      typeof input.description === "string"
        ? input.description.trim().slice(0, maxSceneDescriptionChars)
        : "";
    changes.description = trimmed || null;
  }

  if (input.tags !== undefined) {
    const tags = normalizeTags(input.tags);
    if (tags === undefined) {
      return { error: "invalid_tags" };
    }
    changes.tags = tags;
  }

  // Category is a fixed taxonomy slug (or null to clear), so unlike tags it
  // needs no moderation pass.
  if (input.category !== undefined) {
    const category = normalizeCategory(input.category);
    if (category === undefined) {
      return { error: "invalid_category" };
    }
    changes.category = category;
  }

  if (Object.hasOwn(input, "frameosVersion")) {
    if (input.frameosVersion === null || input.frameosVersion === "") {
      changes.frameosVersion = null;
    } else {
      const frameosVersion = normalizeFrameosVersion(input.frameosVersion);
      if (frameosVersion === undefined) {
        return { error: "invalid_frameos_version" };
      }
      changes.frameosVersion = frameosVersion;
    }
  }

  return { changes };
}

/** The moderation gate an edit that will show on a public page passes: a
 * changed description or tags, and — when the edit is what makes the scene
 * public — the whole listing, cover included. */
export async function moderateListingChanges(options: {
  changes: ListingChanges;
  /** True when this edit is what flips the scene public. */
  makingPublic?: boolean;
  scene: {
    description: string | null;
    name: string;
    previewImage?: Buffer | null;
    previewImageType?: string | null;
  };
}): Promise<
  { ok: true } | { categories?: string[]; error: string; ok: false }
> {
  const { changes, makingPublic = false, scene } = options;
  const editedTags = changes.tags?.length ? changes.tags.join(" ") : undefined;
  if (
    !makingPublic &&
    typeof changes.description !== "string" &&
    !editedTags
  ) {
    return { ok: true };
  }

  const moderation = await moderateStoreContent({
    texts: makingPublic
      ? [scene.name, changes.description ?? scene.description, editedTags]
      : [changes.description, editedTags],
    ...(makingPublic && scene.previewImage
      ? {
          image: {
            content: scene.previewImage,
            contentType: scene.previewImageType ?? "image/jpeg",
          },
        }
      : {}),
  });
  if (moderation.ok) {
    return { ok: true };
  }
  return moderation.error === "content_rejected"
    ? { categories: moderation.categories, error: "content_rejected", ok: false }
    : { error: "moderation_unavailable", ok: false };
}

// "Does the scene have a cover": its latest version links at least one
// image. Listings, tiles and repository indexes gate their <img> on this.
// The tables are named explicitly rather than interpolated as columns: in a
// single-table select drizzle strips the qualifier from columns inside a
// `sql` field, and a bare "id" inside the subquery resolves against the
// wrong table.
export const sceneHasImageSql = sql<boolean>`exists (select 1 from ${storeSceneVersions} v join ${storeSceneVersionImages} vi on vi.version_id = v.id where v.scene_id = ${storeScenes}.id and v.version = ${storeScenes}.latest_version)`;

// The cover's pixel size (position 0 of the latest version's set), for
// listings and social cards; null when unknown or when there is no cover.
const coverColumn = (column: "width" | "height") =>
  sql<number | null>`(select i.${sql.raw(column)} from ${storeSceneVersions} v join ${storeSceneVersionImages} vi on vi.version_id = v.id join ${storeImages} i on i.sha256 = vi.image_sha256 where v.scene_id = ${storeScenes}.id and v.version = ${storeScenes}.latest_version and vi.position = 0)`;
export const sceneCoverWidthSql = coverColumn("width");
export const sceneCoverHeightSql = coverColumn("height");

/** Drizzle condition: the version row of `scene` numbered `version`. */
export function versionRowCondition(sceneId: string, version: number) {
  return and(
    eq(storeSceneVersions.sceneId, sceneId),
    eq(storeSceneVersions.version, version),
  );
}
