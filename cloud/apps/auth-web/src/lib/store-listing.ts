import { normalizeCategory } from "./categories";
import { moderateStoreContent } from "./moderation";
import { normalizeTags } from "./store";

// The listing fields an owner edits without touching the scene's content:
// what the store page says about it. Visibility and the minimum FrameOS
// version are content-adjacent (they republish or re-gate the zip) and stay
// with the PATCH route; these three are just words on a page — which is why
// the AI chat may write them too, through the same parse and the same
// moderation gate as the web form.

export const maxSceneDescriptionChars = 2000;

export type ListingChanges = {
  category?: string | null;
  description?: string | null;
  tags?: string[];
};

/** Reads description / tags / category out of a request body or a tool's
 * arguments. A field left out of the input is left out of the changes: only
 * what was named is edited. Returns the API's own error code when one of
 * them is malformed, so both callers refuse it with the same word. */
export function parseListingChanges(
  input: Record<string, unknown>,
): { changes: ListingChanges } | { error: string } {
  const changes: ListingChanges = {};

  if (typeof input.description === "string" || input.description === null) {
    changes.description =
      typeof input.description === "string"
        ? input.description.slice(0, maxSceneDescriptionChars)
        : null;
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

  return { changes };
}

/** The moderation gate an edit that will show on a public page passes: a
 * changed description or tags, and — when the edit is what makes the scene
 * public — the whole listing, preview image included. */
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
