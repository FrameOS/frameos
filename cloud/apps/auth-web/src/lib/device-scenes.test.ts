import { describe, expect, it } from "vitest";
import {
  deviceSceneContentSha256,
  deviceScenesSummary,
  maxDeviceScenes,
  parseDeviceScenesDocument,
} from "./device-scenes";

const doc = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("parseDeviceScenesDocument", () => {
  it("keeps interpreted scenes with a usable id and counts the compiled ones", () => {
    const parsed = parseDeviceScenesDocument(
      doc({
        active_scene: "clock",
        scenes: [
          { id: "clock", name: "Clock" },
          { id: "clock", name: "A second clock" },
          { id: "legacy", settings: { execution: "compiled" } },
          { name: "no id" },
          { id: "" },
          "not a scene",
          { id: "x".repeat(300) },
        ],
        skipped_compiled: 2,
      }),
    );
    expect(parsed?.scenes.map((scene) => scene.id)).toEqual(["clock"]);
    expect(parsed?.skippedCompiled).toBe(3);
    expect(parsed?.activeScene).toBe("clock");
  });

  it("refuses anything that is not the documented shape", () => {
    expect(parseDeviceScenesDocument(Buffer.alloc(0))).toBeUndefined();
    expect(parseDeviceScenesDocument(Buffer.from("{not json"))).toBeUndefined();
    expect(parseDeviceScenesDocument(doc([{ id: "clock" }]))).toBeUndefined();
    expect(parseDeviceScenesDocument(doc({ scenes: "clock" }))).toBeUndefined();
  });

  it("drops a scene nested deeper than any real one, without overflowing the stack", () => {
    // 200k levels in well under the 8 MiB cap: what a hostile device can send.
    const bomb = `{"scenes":[{"id":"bomb","nodes":${"[".repeat(200_000)}${"]".repeat(200_000)}},{"id":"clock"}]}`;
    const parsed = parseDeviceScenesDocument(Buffer.from(bomb));
    expect(parsed?.scenes.map((scene) => scene.id)).toEqual(["clock"]);
    // And the digest survives depth on content that did not come through the
    // parser (a store version's own scenes).
    let deep: unknown = "leaf";
    for (let level = 0; level < 500; level += 1) {
      deep = { child: deep };
    }
    expect(deviceSceneContentSha256({ id: "deep", nodes: deep })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("bounds the list and ignores a nonsense count or active scene", () => {
    const parsed = parseDeviceScenesDocument(
      doc({
        active_scene: 7,
        scenes: Array.from({ length: maxDeviceScenes + 5 }, (_, index) => ({ id: `s${index}` })),
        skipped_compiled: -4,
      }),
    );
    expect(parsed?.scenes).toHaveLength(maxDeviceScenes);
    expect(parsed?.skippedCompiled).toBe(0);
    expect(parsed?.activeScene).toBeUndefined();
  });
});

describe("deviceSceneContentSha256", () => {
  it("ignores key order and the origin stamp, and nothing else", () => {
    const scene = { id: "clock", name: "Clock", nodes: [{ id: "n1", data: { a: 1, b: 2 } }] };
    const reordered = {
      nodes: [{ data: { b: 2, a: 1 }, id: "n1" }],
      origin: { storeSceneId: "9b2c1c1e-5f3a-4f4e-9d6b-2f1d8c7a6e55", version: "3" },
      name: "Clock",
      id: "clock",
    };
    expect(deviceSceneContentSha256(reordered)).toBe(deviceSceneContentSha256(scene));
    expect(deviceSceneContentSha256({ ...scene, name: "Clock!" })).not.toBe(
      deviceSceneContentSha256(scene),
    );
    // Array order IS content: node order decides render order.
    expect(
      deviceSceneContentSha256({ id: "a", nodes: [1, 2] }),
    ).not.toBe(deviceSceneContentSha256({ id: "a", nodes: [2, 1] }));
  });
});

describe("deviceScenesSummary", () => {
  it("is null without a snapshot and never carries a scene body", () => {
    expect(deviceScenesSummary(undefined)).toBeNull();
    const summary = deviceScenesSummary({
      activeScene: "clock",
      frameId: "f",
      payload: Buffer.from("{}"),
      receivedAt: new Date("2026-09-20T10:00:00Z"),
      result: null,
      sceneCount: 1,
      scenes: [{ id: "clock", name: "Clock", nodes: ["leak"] }, "junk"],
      sizeBytes: 2,
      skippedCompiled: 0,
      status: "ready",
      statusAt: new Date("2026-09-20T10:00:00Z"),
    });
    expect(summary).toEqual({
      received_at: "2026-09-20T10:00:00.000Z",
      result: null,
      scene_count: 1,
      scenes: [{ id: "clock", name: "Clock" }],
      skipped_compiled: 0,
      status: "ready",
    });
  });
});
