import { describe, expect, it } from "vitest";

import { sceneListWithPreview } from "../lib/scene-preview-list";

const a = { id: "a", name: "A" };
const b = { id: "b", name: "B" };

describe("a preview keeps the frame's list", () => {
  it("puts a new scene after the list", () => {
    const p = { id: "p", name: "Preview" };
    expect(sceneListWithPreview([a, b], [p])).toEqual([a, b, p]);
  });

  it("puts an edited scene in the place of the listed one", () => {
    const edited = { ...b, name: "B edited" };
    expect(sceneListWithPreview([a, b], [edited])).toEqual([a, edited]);
  });

  it("keeps a bundle's order for the scenes it adds, and its edits in place", () => {
    const p = { id: "p" };
    const q = { id: "q" };
    const editedA = { ...a, name: "A2" };
    expect(sceneListWithPreview([a, b], [q, editedA, p])).toEqual([editedA, b, q, p]);
  });

  it("is the bundle on a frame with nothing listed", () => {
    expect(sceneListWithPreview([], [a])).toEqual([a]);
  });
});
