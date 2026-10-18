import { beforeEach, describe, expect, it, vi } from "vitest";

const moderate = vi.hoisted(() => vi.fn());
const configured = vi.hoisted(() => ({ value: true }));
const readImage = vi.hoisted(() => vi.fn());

vi.mock("./moderation", () => ({
  isModerationConfigured: () => configured.value,
  moderateStoreContent: moderate,
}));
vi.mock("./store-images", () => ({ readStoreImage: readImage }));

const { moderateStoreImages } = await import("./store-image-moderation");

const image = (objectKey: string) => ({ contentType: "image/png", objectKey });

describe("moderateStoreImages", () => {
  beforeEach(() => {
    configured.value = true;
    moderate.mockReset();
    readImage.mockReset();
    readImage.mockImplementation(async ({ objectKey }: { objectKey: string }) =>
      objectKey === "gone" ? undefined : Buffer.from(objectKey),
    );
  });

  it("sends each image on its own, never any text", async () => {
    moderate.mockResolvedValue({ checked: true, ok: true });
    await expect(moderateStoreImages([image("a"), image("b"), image("gone")])).resolves.toEqual({
      checked: true,
      ok: true,
    });
    expect(moderate).toHaveBeenCalledTimes(2);
    for (const [call] of moderate.mock.calls) {
      expect(call.texts).toEqual([]);
      expect(call.image.contentType).toBe("image/png");
    }
  });

  it("rejects with every category that fired, ahead of an outage", async () => {
    moderate
      .mockResolvedValueOnce({ categories: ["sexual"], error: "content_rejected", ok: false })
      .mockResolvedValueOnce({ error: "moderation_unavailable", ok: false })
      .mockResolvedValueOnce({ categories: ["hate", "sexual"], error: "content_rejected", ok: false });
    await expect(moderateStoreImages([image("a"), image("b"), image("c")])).resolves.toEqual({
      categories: ["hate", "sexual"],
      error: "content_rejected",
      ok: false,
    });
  });

  it("fails closed when one image cannot be checked", async () => {
    moderate
      .mockResolvedValueOnce({ checked: true, ok: true })
      .mockResolvedValueOnce({ error: "moderation_unavailable", ok: false });
    await expect(moderateStoreImages([image("a"), image("b")])).resolves.toEqual({
      error: "moderation_unavailable",
      ok: false,
    });
  });

  it("reads nothing without a moderation key", async () => {
    configured.value = false;
    await expect(moderateStoreImages([image("a")])).resolves.toEqual({ checked: false, ok: true });
    expect(readImage).not.toHaveBeenCalled();
    expect(moderate).not.toHaveBeenCalled();
  });
});
