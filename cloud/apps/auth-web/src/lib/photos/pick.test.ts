import { describe, expect, it } from "vitest";
import {
  filterPhotoShapes,
  mulberry32,
  parsePhotoOrder,
  parsePhotoShapes,
  photoShape,
  pickPhoto,
  seedFromString,
  seededShuffle,
  sortPhotos,
} from "./pick";

const album = [
  { mtime: 300, path: "b/10.jpg" },
  { mtime: 100, path: "a.jpg" },
  { mtime: 200, path: "b/2.jpg" },
  { mtime: 200, path: "b/1.jpg" },
  { mtime: 50, path: "c.jpg" },
];

function cycle(order: "random" | "sequential" | "newest" | "oldest", start: number, token = "pk_t") {
  return Array.from(
    { length: album.length },
    (_, offset) => pickPhoto(album, { index: start + offset, order, token }).photo?.path,
  );
}

describe("parsePhotoOrder", () => {
  it("defaults to random and refuses unknown orders", () => {
    expect(parsePhotoOrder(null)).toBe("random");
    expect(parsePhotoOrder("")).toBe("random");
    expect(parsePhotoOrder("newest")).toBe("newest");
    expect(parsePhotoOrder("shuffle")).toBeUndefined();
  });
});

describe("sortPhotos", () => {
  it("orders by path naturally, or by mtime then path", () => {
    expect(sortPhotos(album, "sequential").map((photo) => photo.path)).toEqual([
      "a.jpg",
      "b/1.jpg",
      "b/2.jpg",
      "b/10.jpg",
      "c.jpg",
    ]);
    expect(sortPhotos(album, "newest").map((photo) => photo.path)).toEqual([
      "b/10.jpg",
      "b/1.jpg",
      "b/2.jpg",
      "a.jpg",
      "c.jpg",
    ]);
    expect(sortPhotos(album, "oldest").map((photo) => photo.path)).toEqual([
      "c.jpg",
      "a.jpg",
      "b/1.jpg",
      "b/2.jpg",
      "b/10.jpg",
    ]);
  });
});

describe("seeded shuffle", () => {
  it("is deterministic for a seed and leaves its input alone", () => {
    const items = Array.from({ length: 50 }, (_, index) => index);
    const first = seededShuffle(items, "pk_abc:0");
    expect(seededShuffle(items, "pk_abc:0")).toEqual(first);
    expect(items).toEqual(Array.from({ length: 50 }, (_, index) => index));
    expect([...first].sort((a, b) => a - b)).toEqual(items);
    expect(seededShuffle(items, "pk_abc:1")).not.toEqual(first);
  });

  it("produces floats in [0, 1)", () => {
    const random = mulberry32(seedFromString("x"));
    for (let index = 0; index < 1000; index += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("pickPhoto", () => {
  it("walks the fixed orders, wrapping at the end", () => {
    expect(cycle("sequential", 0)).toEqual(["a.jpg", "b/1.jpg", "b/2.jpg", "b/10.jpg", "c.jpg"]);
    expect(pickPhoto(album, { index: 5, order: "sequential", token: "t" }).photo?.path).toBe(
      "a.jpg",
    );
    expect(cycle("newest", 0)[0]).toBe("b/10.jpg");
    expect(cycle("oldest", 0)[0]).toBe("c.jpg");
  });

  it("shows every photo once per random cycle, in a new order each cycle", () => {
    const orders = Array.from({ length: 6 }, (_, cycleNumber) =>
      cycle("random", cycleNumber * album.length),
    );
    for (const order of orders) {
      expect([...order].sort()).toEqual(album.map((photo) => photo.path).sort());
    }
    // Six cycles of five photos: at least two distinct orders (120 exist).
    expect(new Set(orders.map((order) => order.join("|"))).size).toBeGreaterThan(1);
  });

  it("is deterministic for a token and index, whatever order the caller listed", () => {
    const reversed = [...album].reverse();
    for (let index = 0; index < 20; index += 1) {
      expect(pickPhoto(reversed, { index, order: "random", token: "pk_x" }).photo?.path).toBe(
        pickPhoto(album, { index, order: "random", token: "pk_x" }).photo?.path,
      );
    }
  });

  it("depends on the token", () => {
    const differs = Array.from({ length: 20 }, (_, index) => `pk_${index}`).some(
      (token) => cycle("random", 0, token).join() !== cycle("random", 0, "pk_t").join(),
    );
    expect(differs).toBe(true);
  });

  it("answers an empty album with count 0 and no photo", () => {
    expect(pickPhoto([], { index: 7, order: "random", token: "t" })).toEqual({
      count: 0,
      index: 7,
      photo: null,
    });
  });
});

describe("photo shapes", () => {
  it("names a photo's shape by its pixels, or not at all", () => {
    expect(photoShape(40, 30)).toBe("landscape");
    expect(photoShape(30, 40)).toBe("portrait");
    expect(photoShape(30, 30)).toBe("square");
    expect(photoShape(null, 30)).toBeNull();
    expect(photoShape(0, 0)).toBeNull();
  });

  it("parses the query and the body, every shape being no filter", () => {
    expect(parsePhotoShapes(null)).toBeNull();
    expect(parsePhotoShapes("")).toBeNull();
    expect(parsePhotoShapes("landscape,portrait,square")).toBeNull();
    expect(parsePhotoShapes("square, landscape")).toEqual(["landscape", "square"]);
    expect(parsePhotoShapes(["portrait"])).toEqual(["portrait"]);
    expect(parsePhotoShapes("landscape,round")).toBeUndefined();
  });

  it("keeps the photos of the chosen shapes, and photos of unknown size only without a choice", () => {
    const photos = [
      { height: 30, path: "l", width: 40 },
      { height: 40, path: "p", width: 30 },
      { height: 30, path: "s", width: 30 },
      { height: null, path: "u", width: null },
    ];
    expect(filterPhotoShapes(photos, null).map((photo) => photo.path)).toEqual(["l", "p", "s", "u"]);
    expect(filterPhotoShapes(photos, ["portrait"]).map((photo) => photo.path)).toEqual(["p"]);
    expect(filterPhotoShapes(photos, ["landscape", "square"]).map((photo) => photo.path)).toEqual(["l", "s"]);
  });
});
