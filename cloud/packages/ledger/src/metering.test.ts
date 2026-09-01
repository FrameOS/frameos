import { describe, expect, it } from "vitest";
import { absorbedSurfaces, surfaceIsAbsorbed } from "./metering";

// The absorbed-surface policy, tested away from the database because it is a
// business decision rather than a query: what we hand out for free stays a
// cost line no matter which key pays for it or what Phase 3 does to the rest.
describe("absorbed surfaces", () => {
  it("absorbs scene conversion", () => {
    expect(surfaceIsAbsorbed("scene_convert")).toBe(true);
    expect(absorbedSurfaces).toContain("scene_convert");
  });

  it("leaves the billable surfaces alone", () => {
    expect(surfaceIsAbsorbed("scene_chat")).toBe(false);
    expect(surfaceIsAbsorbed("app_chat")).toBe(false);
    expect(surfaceIsAbsorbed("store_classify")).toBe(false);
  });

  // A turn with no surface is the general case (an older record, a caller
  // that did not say): it must not fall into the free bucket by accident.
  it("does not absorb a turn that names no surface", () => {
    expect(surfaceIsAbsorbed(null)).toBe(false);
    expect(surfaceIsAbsorbed(undefined)).toBe(false);
    expect(surfaceIsAbsorbed("")).toBe(false);
  });
});
