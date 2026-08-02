import { describe, expect, it } from "vitest";
import {
  compareFrameosVersions,
  frameosVersionKey,
  frameosVersionSatisfies,
  normalizeRequestedFrameosVersion,
  sortFrameosVersionsDesc,
} from "./store-versions";

describe("compareFrameosVersions", () => {
  it("compares components numerically, not as strings", () => {
    // The case that breaks lexicographic sorting: "2026.10.0" < "2026.9.0" as
    // text, but the tenth release of the year is the newer one.
    expect("2026.10.0" < "2026.9.0").toBe(true);
    expect(compareFrameosVersions("2026.10.0", "2026.9.0")).toBe(1);
    expect(compareFrameosVersions("2026.9.0", "2026.10.0")).toBe(-1);
    expect(compareFrameosVersions("2026.10.0", "2026.10.0")).toBe(0);
  });

  it("orders across years, minors and patches", () => {
    expect(compareFrameosVersions("2027.1.0", "2026.12.9")).toBe(1);
    expect(compareFrameosVersions("2026.8.2", "2026.8.10")).toBe(-1);
    expect(compareFrameosVersions("2026.8", "2026.8.0")).toBe(0);
    expect(compareFrameosVersions("2026.8.1", "2026.8")).toBe(1);
  });

  it("ignores prerelease suffixes and leading zeros", () => {
    expect(compareFrameosVersions("2026.9.0-rc1", "2026.9.0")).toBe(0);
    expect(compareFrameosVersions("2026.09.0", "2026.9.0")).toBe(0);
  });

  it("sorts unreadable versions before real ones", () => {
    expect(compareFrameosVersions("nightly", "2026.9.0")).toBe(-1);
    expect(compareFrameosVersions("2026.9.0", null)).toBe(1);
    expect(compareFrameosVersions(undefined, "")).toBe(0);
  });
});

describe("frameosVersionKey", () => {
  it("zero-pads to four components", () => {
    expect(frameosVersionKey("2026.9")).toEqual([2026, 9, 0, 0]);
    expect(frameosVersionKey(" 2026.9.1.2 ")).toEqual([2026, 9, 1, 2]);
    expect(frameosVersionKey("2026.9.1.2.3")).toEqual([2026, 9, 1, 2]);
  });

  it("returns undefined for values that are not versions", () => {
    expect(frameosVersionKey("")).toBeUndefined();
    expect(frameosVersionKey("nightly")).toBeUndefined();
    expect(frameosVersionKey("v2026.9.0")).toBeUndefined();
    expect(frameosVersionKey(null)).toBeUndefined();
  });
});

describe("frameosVersionSatisfies", () => {
  it("hides scenes that need a newer FrameOS", () => {
    expect(frameosVersionSatisfies("2026.10.0", "2026.9.0")).toBe(false);
    expect(frameosVersionSatisfies("2026.9.0", "2026.10.0")).toBe(true);
    expect(frameosVersionSatisfies("2026.9.0", "2026.9.0")).toBe(true);
    expect(frameosVersionSatisfies("2026.9.1", "2026.9")).toBe(false);
  });

  it("keeps scenes whose requirement cannot be read", () => {
    expect(frameosVersionSatisfies(null, "2026.9.0")).toBe(true);
    expect(frameosVersionSatisfies("", "2026.9.0")).toBe(true);
    expect(frameosVersionSatisfies("nightly", "2026.9.0")).toBe(true);
    expect(frameosVersionSatisfies("2026.10.0", "nightly")).toBe(true);
  });
});

describe("sortFrameosVersionsDesc", () => {
  it("puts the newest version first and deduplicates", () => {
    expect(
      sortFrameosVersionsDesc([
        "2026.9.0",
        "2026.10.0",
        "2026.9.0",
        "2025.12.4",
      ]),
    ).toEqual(["2026.10.0", "2026.9.0", "2025.12.4"]);
  });
});

describe("normalizeRequestedFrameosVersion", () => {
  it("accepts dotted numbers only", () => {
    expect(normalizeRequestedFrameosVersion("2026.10.0")).toBe("2026.10.0");
    expect(normalizeRequestedFrameosVersion(" 2026.8 ")).toBe("2026.8");
    expect(normalizeRequestedFrameosVersion("2026")).toBe("2026");
  });

  it("rejects anything that is not a plain version", () => {
    expect(normalizeRequestedFrameosVersion("v2026.8")).toBeUndefined();
    expect(normalizeRequestedFrameosVersion("2026.8.0-rc1")).toBeUndefined();
    expect(normalizeRequestedFrameosVersion("account")).toBeUndefined();
    expect(normalizeRequestedFrameosVersion("../../etc")).toBeUndefined();
    expect(normalizeRequestedFrameosVersion("2026.8.0.1.2")).toBeUndefined();
    expect(normalizeRequestedFrameosVersion(null)).toBeUndefined();
  });
});
