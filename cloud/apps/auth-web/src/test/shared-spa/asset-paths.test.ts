import { describe, expect, it } from "vitest";
import {
  assetPathKey,
  normalizeAssetPath,
  withRenamedAsset,
  withoutDeletedAsset,
} from "../../../../../../frontend/src/scenes/frame/panels/Assets/assetPaths";

// The Assets panel's listing comes in two spellings: the backend lists
// absolute paths under the frame's assets directory, while the cloud hub
// caches the device's `assets_list` reply, whose paths are relative to that
// directory (parseAssetEntries in src/lib/frames.ts refuses absolute ones).
// Deletes and renames used to match rows by the absolute spelling only, so on
// a cloud frame the deleted row stayed on screen until the next reload.
describe("assetPathKey", () => {
  it("collapses every spelling of the same asset to one key", () => {
    expect(assetPathKey("/srv/assets/photos/a.jpg", "/srv/assets")).toBe(
      "photos/a.jpg",
    );
    expect(assetPathKey("photos/a.jpg", "/srv/assets")).toBe("photos/a.jpg");
    expect(assetPathKey("./photos/a.jpg", "/srv/assets")).toBe("photos/a.jpg");
    expect(assetPathKey("/photos/a.jpg", "/srv/assets")).toBe("photos/a.jpg");
    expect(assetPathKey("photos/a.jpg")).toBe("photos/a.jpg");
  });

  it("treats the assets directory itself as the root", () => {
    expect(assetPathKey("/srv/assets", "/srv/assets")).toBe("");
    expect(assetPathKey("/srv/assets/", "/srv/assets/")).toBe("");
    expect(assetPathKey(".", "/srv/assets")).toBe("");
    expect(assetPathKey("", "/srv/assets")).toBe("");
  });

  it("honours a custom assets directory", () => {
    expect(assetPathKey("/sdcard/frameos/a.jpg", "/sdcard/frameos")).toBe(
      "a.jpg",
    );
    expect(assetPathKey("a.jpg", "/sdcard/frameos")).toBe("a.jpg");
  });
});

describe("withoutDeletedAsset", () => {
  const cloudListing = [
    { path: "photos/a.jpg" },
    { path: "photos/b.jpg" },
    { path: "photos" },
    { path: "photos-archive/c.jpg" },
  ];
  const backendListing = cloudListing.map((asset) => ({
    path: normalizeAssetPath(asset.path, "/srv/assets"),
  }));

  it("drops a relative (cloud) row when the panel deletes by tree path", () => {
    expect(
      withoutDeletedAsset(cloudListing, "photos/a.jpg", "/srv/assets"),
    ).toEqual([
      { path: "photos/b.jpg" },
      { path: "photos" },
      { path: "photos-archive/c.jpg" },
    ]);
  });

  it("drops an absolute (backend) row the same way", () => {
    expect(
      withoutDeletedAsset(backendListing, "photos/a.jpg", "/srv/assets"),
    ).toEqual([
      { path: "/srv/assets/photos/b.jpg" },
      { path: "/srv/assets/photos" },
      { path: "/srv/assets/photos-archive/c.jpg" },
    ]);
  });

  it("drops a folder with its subtree but not a sibling sharing the prefix", () => {
    expect(withoutDeletedAsset(cloudListing, "photos", "/srv/assets")).toEqual([
      { path: "photos-archive/c.jpg" },
    ]);
  });

  it("never wipes the listing for the root", () => {
    expect(withoutDeletedAsset(cloudListing, "", "/srv/assets")).toBe(
      cloudListing,
    );
    expect(
      withoutDeletedAsset(cloudListing, "/srv/assets", "/srv/assets"),
    ).toBe(cloudListing);
  });
});

describe("withRenamedAsset", () => {
  it("moves relative rows and keeps them relative", () => {
    expect(
      withRenamedAsset(
        [
          { path: "photos/a.jpg" },
          { path: "./photos/b.jpg" },
          { path: "other/c.jpg" },
        ],
        "photos",
        "pics",
        "/srv/assets",
      ),
    ).toEqual([
      { path: "pics/a.jpg" },
      { path: "./pics/b.jpg" },
      { path: "other/c.jpg" },
    ]);
  });

  it("moves absolute rows and keeps them absolute", () => {
    expect(
      withRenamedAsset(
        [{ path: "/srv/assets/photos/a.jpg" }, { path: "/srv/assets/photos" }],
        "photos",
        "pics",
        "/srv/assets",
      ),
    ).toEqual([
      { path: "/srv/assets/pics/a.jpg" },
      { path: "/srv/assets/pics" },
    ]);
  });

  it("renames a single file", () => {
    expect(
      withRenamedAsset([{ path: "a.jpg" }], "a.jpg", "b.jpg", "/srv/assets"),
    ).toEqual([{ path: "b.jpg" }]);
  });
});
