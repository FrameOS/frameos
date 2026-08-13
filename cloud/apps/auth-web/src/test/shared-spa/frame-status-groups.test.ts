// The fleet sidebar/home grouping (Active / Inactive / Archived).
//
// frameIsActive grew up on backend fields — active_connections, last_log_at,
// status "ready" — none of which a cloud frame carries. Its summary has the
// hub-maintained `connected` flag, `last_seen_at` and status "active", so
// every cloud frame used to land under "Inactive" while saying "last seen
// just now" two lines below. Pure-function suite, tested from auth-web like
// the other shared-SPA logic (frontend/ has no test runner).
import { describe, expect, it } from "vitest";
import { groupFramesByStatus } from "../../../../../../frontend/src/scenes/workspace/frameStatusGroups";
import type { FrameType } from "../../../../../../frontend/src/types";

function groupOf(frame: Partial<FrameType>): string {
  const groups = groupFramesByStatus([
    { id: "frame-1", name: "Frame", ...frame } as FrameType,
  ]);
  expect(groups).toHaveLength(1);
  return groups[0]!.key;
}

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

describe("cloud frames in the status groups", () => {
  it("counts a connected cloud frame as active", () => {
    expect(
      groupOf({ connected: true, last_seen_at: minutesAgo(0), status: "active" }),
    ).toBe("active");
  });

  it("counts a recently-seen but momentarily disconnected frame as active", () => {
    expect(
      groupOf({ connected: false, last_seen_at: minutesAgo(5), status: "active" }),
    ).toBe("active");
  });

  it("moves a frame not seen for over an hour to inactive", () => {
    expect(
      groupOf({ connected: false, last_seen_at: minutesAgo(90), status: "active" }),
    ).toBe("inactive");
  });

  it("keeps a never-enrolled frame inactive", () => {
    expect(groupOf({ status: "pending" })).toBe("inactive");
  });
});

describe("backend frames in the status groups", () => {
  it("keeps ready frames with fresh logs active", () => {
    expect(groupOf({ last_log_at: minutesAgo(1), status: "ready" })).toBe(
      "active",
    );
  });

  it("keeps stale-logged frames inactive", () => {
    expect(groupOf({ last_log_at: minutesAgo(120), status: "ready" })).toBe(
      "inactive",
    );
  });

  it("keeps archived frames archived, whatever else they report", () => {
    expect(
      groupOf({ archived: true, connected: true, status: "active" }),
    ).toBe("archived");
  });
});
