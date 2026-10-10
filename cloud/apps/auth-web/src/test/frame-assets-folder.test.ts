import { describe, expect, it } from "vitest";
import { directChildren } from "../lib/frame-asset-cache";

// The assets route answers `?folder=` with one folder's direct children cut
// out of the hub's cached device listing (relative paths, as the device
// sends them). The shared SPA loads a folder at a time with it.
describe("directChildren", () => {
  const listing = [
    { path: "fonts", is_dir: true },
    { path: "photos", is_dir: true },
    { path: "photos/cat.jpg" },
    { path: "photos/cat.jpg.frameos.json" },
    { path: "photos/trip", is_dir: true },
    { path: "photos/trip/beach.jpg" },
    { path: "./notes.txt" },
    { path: 42 },
    null,
  ];

  it("lists the root", () => {
    expect(directChildren(listing, "").map((a) => (a as { path: string }).path)).toEqual([
      "fonts",
      "photos",
      "./notes.txt",
    ]);
    expect(directChildren(listing, ".")).toHaveLength(3);
  });

  it("lists one folder, whatever spelling names it", () => {
    for (const folder of ["photos", "./photos", "/photos/", "photos/"]) {
      expect(directChildren(listing, folder).map((a) => (a as { path: string }).path)).toEqual([
        "photos/cat.jpg",
        "photos/cat.jpg.frameos.json",
        "photos/trip",
      ]);
    }
    expect(directChildren(listing, "photos/trip")).toHaveLength(1);
    expect(directChildren(listing, "missing")).toHaveLength(0);
  });
});
