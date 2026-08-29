import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxSceneDescriptionChars, parseListingChanges } from "./store-listing";

const moderate = vi.hoisted(() =>
  vi.fn(async () => ({ checked: true, ok: true }) as never),
);
vi.mock("./moderation", () => ({ moderateStoreContent: moderate }));

const { moderateListingChanges } = await import("./store-listing");

const scene = {
  description: "The old blurb",
  name: "Visited world map",
  previewImage: Buffer.from("jpeg"),
  previewImageType: "image/jpeg",
};

describe("parseListingChanges", () => {
  it("edits only the fields that were named", () => {
    expect(parseListingChanges({ description: "New blurb" })).toEqual({
      changes: { description: "New blurb" },
    });
    expect(parseListingChanges({})).toEqual({ changes: {} });
  });

  it("clears a field with null and caps a long description", () => {
    expect(parseListingChanges({ description: null })).toEqual({
      changes: { description: null },
    });
    const long = parseListingChanges({ description: "x".repeat(5000) });
    expect(
      (long as { changes: { description: string } }).changes.description,
    ).toHaveLength(maxSceneDescriptionChars);
  });

  it("normalizes tags and refuses malformed ones", () => {
    expect(parseListingChanges({ tags: ["Maps", "maps", "travel"] })).toEqual({
      changes: { tags: ["maps", "travel"] },
    });
    expect(parseListingChanges({ tags: ["not a tag"] })).toEqual({
      error: "invalid_tags",
    });
    expect(parseListingChanges({ tags: "maps" })).toEqual({
      error: "invalid_tags",
    });
  });

  it("takes a category slug from the taxonomy, or null to clear it", () => {
    expect(parseListingChanges({ category: "art" })).toEqual({
      changes: { category: "art" },
    });
    expect(parseListingChanges({ category: null })).toEqual({
      changes: { category: null },
    });
    expect(parseListingChanges({ category: "nonsense" })).toEqual({
      error: "invalid_category",
    });
  });
});

describe("moderateListingChanges", () => {
  beforeEach(() => {
    moderate.mockClear();
    moderate.mockResolvedValue({ checked: true, ok: true } as never);
  });

  it("skips the gate when nothing public-facing changed", async () => {
    await expect(
      moderateListingChanges({ changes: { category: "art" }, scene }),
    ).resolves.toEqual({ ok: true });
    expect(moderate).not.toHaveBeenCalled();
  });

  it("checks a changed description and tags, and nothing else", async () => {
    await moderateListingChanges({
      changes: { description: "New blurb", tags: ["maps", "travel"] },
      scene,
    });
    expect(moderate).toHaveBeenCalledWith({
      texts: ["New blurb", "maps travel"],
    });
  });

  it("checks the whole listing, image included, when the edit publishes it", async () => {
    await moderateListingChanges({
      changes: {},
      makingPublic: true,
      scene,
    });
    expect(moderate).toHaveBeenCalledWith({
      image: { content: scene.previewImage, contentType: "image/jpeg" },
      texts: ["Visited world map", "The old blurb", undefined],
    });
  });

  it("reports a refusal with its categories, and an outage separately", async () => {
    moderate.mockResolvedValue({
      categories: ["violence"],
      error: "content_rejected",
      ok: false,
    } as never);
    await expect(
      moderateListingChanges({ changes: { description: "bad" }, scene }),
    ).resolves.toEqual({
      categories: ["violence"],
      error: "content_rejected",
      ok: false,
    });

    moderate.mockResolvedValue({ error: "unavailable", ok: false } as never);
    await expect(
      moderateListingChanges({ changes: { description: "bad" }, scene }),
    ).resolves.toEqual({ error: "moderation_unavailable", ok: false });
  });
});
