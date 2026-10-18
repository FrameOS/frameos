import { beforeEach, describe, expect, it } from "vitest";
import { resetDownloadCountsForTests, shouldCountDownload } from "./store-download-count";

describe("shouldCountDownload", () => {
  beforeEach(() => resetDownloadCountsForTests());

  it("counts a scene once per address per UTC day", () => {
    const morning = new Date("2026-10-18T08:00:00Z");
    const evening = new Date("2026-10-18T23:59:00Z");
    const tomorrow = new Date("2026-10-19T00:01:00Z");
    expect(shouldCountDownload("scene-a", "203.0.113.7", morning)).toBe(true);
    expect(shouldCountDownload("scene-a", "203.0.113.7", evening)).toBe(false);
    expect(shouldCountDownload("scene-b", "203.0.113.7", evening)).toBe(true);
    expect(shouldCountDownload("scene-a", "198.51.100.2", evening)).toBe(true);
    expect(shouldCountDownload("scene-a", "203.0.113.7", tomorrow)).toBe(true);
  });
});
