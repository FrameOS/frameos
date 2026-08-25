import { describe, expect, it } from "vitest";
import { mergePositions, needsRealign, realPosition } from "./realign";

const node = (id: string, position?: unknown, extra: Record<string, unknown> = {}) => ({
  data: { keyword: id },
  id,
  type: "app",
  ...(position === undefined ? {} : { position }),
  ...extra,
});

describe("realPosition", () => {
  it("returns numeric positions", () => {
    expect(realPosition(node("a", { x: 10, y: -20 }))).toEqual({ x: 10, y: -20 });
    expect(realPosition(node("a", { x: 0, y: 0 }))).toEqual({ x: 0, y: 0 });
  });

  it("rejects missing, partial, non-finite and sentinel positions", () => {
    expect(realPosition(node("a"))).toBeNull();
    expect(realPosition(node("a", { x: 1 }))).toBeNull();
    expect(realPosition(node("a", { x: "1", y: 2 }))).toBeNull();
    expect(realPosition(node("a", { x: Number.NaN, y: 2 }))).toBeNull();
    expect(realPosition(node("a", { x: -9999, y: -9999 }))).toBeNull();
    expect(realPosition(null)).toBeNull();
  });

  it("keeps a single -9999 coordinate (only the pair is the sentinel)", () => {
    expect(realPosition(node("a", { x: -9999, y: 5 }))).toEqual({ x: -9999, y: 5 });
  });
});

describe("needsRealign", () => {
  it("is false for a scene whose nodes all sit somewhere distinct", () => {
    expect(
      needsRealign({ id: "s", nodes: [node("a", { x: 0, y: 0 }), node("b", { x: 300, y: 0 })] }),
    ).toBe(false);
  });

  it("is true when any node has no real position", () => {
    expect(needsRealign({ id: "s", nodes: [node("a", { x: 0, y: 0 }), node("b")] })).toBe(true);
    expect(
      needsRealign({ id: "s", nodes: [node("a", { x: -9999, y: -9999 }), node("b", { x: 1, y: 1 })] }),
    ).toBe(true);
  });

  it("is true when every node is stacked on the same point", () => {
    expect(
      needsRealign({ id: "s", nodes: [node("a", { x: 0, y: 0 }), node("b", { x: 0, y: 0 })] }),
    ).toBe(true);
  });

  it("is false for a single placed node and for an empty scene", () => {
    expect(needsRealign({ id: "s", nodes: [node("a", { x: 0, y: 0 })] })).toBe(false);
    expect(needsRealign({ id: "s", nodes: [] })).toBe(false);
    expect(needsRealign({ id: "s" })).toBe(false);
  });

  it("is true while the autoArrangeOnLoad marker is set", () => {
    expect(
      needsRealign({
        id: "s",
        nodes: [node("a", { x: 0, y: 0 }), node("b", { x: 300, y: 0 })],
        settings: { autoArrangeOnLoad: true },
      }),
    ).toBe(true);
  });

  it("ignores non-objects", () => {
    expect(needsRealign(null)).toBe(false);
    expect(needsRealign("scene")).toBe(false);
  });
});

describe("mergePositions", () => {
  const original = [
    {
      edges: [{ id: "e", source: "a", target: "b" }],
      id: "s1",
      name: "One",
      nodes: [node("a"), node("b", { x: -9999, y: -9999 }, { width: 200 })],
      settings: { autoArrangeOnLoad: true, execution: "interpreted" },
    },
    { id: "s2", name: "Two", nodes: [node("c", { x: 5, y: 5 })] },
  ];

  it("takes only positions from the arranged scenes and drops the marker", () => {
    const arranged = [
      {
        id: "s1",
        name: "One (renamed by editor)",
        nodes: [
          { ...node("a", { x: 10, y: 20 }), data: { keyword: "changed" }, height: 100, width: 300 },
          node("b", { x: 400, y: 20 }),
          node("extra", { x: 1, y: 1 }),
        ],
        settings: { execution: "interpreted" },
      },
    ];
    const merged = mergePositions(original, arranged) as Record<string, unknown>[];
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({
      edges: [{ id: "e", source: "a", target: "b" }],
      id: "s1",
      name: "One",
      nodes: [
        node("a", { x: 10, y: 20 }),
        node("b", { x: 400, y: 20 }, { width: 200 }),
      ],
      settings: { execution: "interpreted" },
    });
    // A scene the editor did not report is returned as it was.
    expect(merged[1]).toEqual(original[1]);
    // Inputs are not mutated.
    expect(original[0]!.settings).toEqual({ autoArrangeOnLoad: true, execution: "interpreted" });
    expect(original[0]!.nodes[0]).toEqual(node("a"));
  });

  it("keeps a node's own position when the editor reports a sentinel for it", () => {
    const arranged = [
      { id: "s2", nodes: [node("c", { x: -9999, y: -9999 })] },
    ];
    const merged = mergePositions(original, arranged) as Record<string, unknown>[];
    expect(merged[1]).toEqual(original[1]);
  });

  it("removes an empty settings object left behind by the marker, keeps other settings objects", () => {
    const merged = mergePositions(
      [
        { id: "s", nodes: [], settings: { autoArrangeOnLoad: true } },
        { id: "t", nodes: [], settings: {} },
        { id: "u", nodes: [] },
      ],
      null,
    ) as Record<string, unknown>[];
    expect(merged[0]).toEqual({ id: "s", nodes: [] });
    expect(merged[1]).toEqual({ id: "t", nodes: [], settings: {} });
    expect(merged[2]).toEqual({ id: "u", nodes: [] });
  });

  it("returns the originals untouched when nothing was reported", () => {
    expect(mergePositions([original[1]], null)).toEqual([original[1]]);
    expect(mergePositions([original[1]], [])).toEqual([original[1]]);
  });

  it("throws when the editor lost a node", () => {
    expect(() =>
      mergePositions(original, [{ id: "s1", nodes: [node("a", { x: 1, y: 1 })] }]),
    ).toThrow(/expected 2/);
  });

  it("passes non-object entries through", () => {
    expect(mergePositions([null, "x"], [])).toEqual([null, "x"]);
  });
});
