import { describe, expect, it } from "vitest";
import { compareFrames } from "../../../../../../frontend/src/utils/frameSort";

// The fleet selectors sort every frame on every load. The old comparator
// assumed frame_host exists (a backend invariant); a freshly enrolled cloud
// frame has no frame_host and — when nothing was typed at flash time — no
// name either, and one such frame white-screened the whole workspace
// (TypeError inside Array.sort in the activeFramesList selector).
describe("compareFrames", () => {
  it("survives a nameless, hostless pending frame", () => {
    const frames = [
      { frame_host: "kitchen.local", id: 1, name: "Kitchen", ssh_user: "pi" },
      // The crash case: enrolled seconds ago, nothing but an id.
      { id: "b3f1c9a0-0000-4000-8000-000000000001", name: null },
      { id: "a2222222-0000-4000-8000-000000000002", name: "Hallway e-ink" },
    ];
    expect(() => [...frames].sort(compareFrames)).not.toThrow();
  });

  it("sorts by host, then name, with the opaque id as a stable tie-break", () => {
    const nameless = { id: "b-uuid" };
    const named = { id: "a-uuid", name: "Hallway" };
    const hosted = { frame_host: "attic.local", id: 7, ssh_user: "pi" };
    const sorted = [nameless, hosted, named].sort(compareFrames);
    // Empty labels first, then alphabetical labels.
    expect(sorted).toEqual([nameless, hosted, named]);

    // Two label-less frames keep a deterministic order via their ids.
    const twinA = { id: "aaa" };
    const twinB = { id: "bbb" };
    expect([twinB, twinA].sort(compareFrames)).toEqual([twinA, twinB]);
  });
});
