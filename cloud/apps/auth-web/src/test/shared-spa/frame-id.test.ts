import { describe, expect, it } from "vitest";
import {
  frameById,
  frameIdsEqual,
  parseRouteFrameId,
} from "../../../../../../frontend/src/utils/frameId";

// The shared workspace SPA (frontend/src) is served by three control planes.
// The FrameOS backend numbers its frames; FrameOS Cloud keys them by uuid
// (cloud/packages/db schema `frames.id` is a `uuid`, handed to the SPA
// verbatim by `frameSummary`). The SPA used to `parseInt` route segments and
// compare `frame.id === routeFrameId`, so on the cloud a deep link either
// resolved to NaN or — worse — to the wrong frame, because "7b3f…".parseInt
// is 7. These tests pin the replacement helpers.
//
// There is no test runner inside frontend/, so the shared module is exercised
// from here; it is deliberately free of React, kea and the DOM.

describe("parseRouteFrameId", () => {
  it("keeps a backend's numeric id numeric", () => {
    expect(parseRouteFrameId("7")).toBe(7);
    expect(parseRouteFrameId("42")).toBe(42);
  });

  it("keeps a cloud uuid intact instead of truncating it to a number", () => {
    const uuid = "7b3f1c2e-9d4a-4f61-8f0c-1a2b3c4d5e6f";
    expect(parseRouteFrameId(uuid)).toBe(uuid);
    // The bug this replaces: parseInt("7b3f…", 10) === 7.
    expect(parseRouteFrameId(uuid)).not.toBe(7);
  });

  it("treats absent or blank segments as no selection", () => {
    expect(parseRouteFrameId(undefined)).toBeNull();
    expect(parseRouteFrameId(null)).toBeNull();
    expect(parseRouteFrameId("")).toBeNull();
    expect(parseRouteFrameId("   ")).toBeNull();
  });
});

describe("frameIdsEqual", () => {
  it("matches across the string/number boundary a route always crosses", () => {
    expect(frameIdsEqual(7, "7")).toBe(true);
    expect(frameIdsEqual("7", 7)).toBe(true);
  });

  it("matches uuids", () => {
    const uuid = "7b3f1c2e-9d4a-4f61-8f0c-1a2b3c4d5e6f";
    expect(frameIdsEqual(uuid, uuid)).toBe(true);
  });

  it("does not match different frames", () => {
    expect(frameIdsEqual(7, 8)).toBe(false);
    expect(
      frameIdsEqual(
        "7b3f1c2e-9d4a-4f61-8f0c-1a2b3c4d5e6f",
        "8c4e2d3f-0e5b-4a72-9f1d-2b3c4d5e6f70",
      ),
    ).toBe(false);
  });

  it("never matches a missing id", () => {
    expect(frameIdsEqual(null, null)).toBe(false);
    expect(frameIdsEqual(undefined, 7)).toBe(false);
    expect(frameIdsEqual(7, null)).toBe(false);
  });
});

describe("deep-linking to a frame", () => {
  // The regression: with more than one frame, a uuid route fell through to
  // `selectedFrame ?? activeFramesList[0]` and opened SOMEBODY ELSE'S frame.
  const frames = [
    { id: "7b3f1c2e-9d4a-4f61-8f0c-1a2b3c4d5e6f", name: "Kitchen" },
    { id: "8c4e2d3f-0e5b-4a72-9f1d-2b3c4d5e6f70", name: "Studio" },
  ];

  it("resolves a cloud uuid route to the frame it names, not the first one", () => {
    const routeFrameId = parseRouteFrameId(
      "8c4e2d3f-0e5b-4a72-9f1d-2b3c4d5e6f70",
    );
    const match = frames.find((frame) =>
      frameIdsEqual(frame.id, routeFrameId),
    );
    expect(match?.name).toBe("Studio");
  });

  it("still resolves numeric backend routes", () => {
    const numericFrames = [
      { id: 7, name: "Kitchen" },
      { id: 8, name: "Studio" },
    ];
    const routeFrameId = parseRouteFrameId("8");
    expect(
      numericFrames.find((frame) => frameIdsEqual(frame.id, routeFrameId))
        ?.name,
    ).toBe("Studio");
  });
});

describe("frameById", () => {
  it("looks frames up with either id flavour", () => {
    const record = { 7: "backend", "7b3f1c2e": "cloud" };
    expect(frameById(record, 7)).toBe("backend");
    expect(frameById(record, "7")).toBe("backend");
    expect(frameById(record, "7b3f1c2e")).toBe("cloud");
    expect(frameById(record, null)).toBeUndefined();
  });
});
