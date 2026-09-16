import { describe, expect, it } from "vitest";
import {
  bridgeFlowEdges,
  edgesAfterDeletingNodes,
} from "../../../../../../frontend/src/scenes/frame/panels/Diagram/flowBridging";
import type { DiagramEdge } from "../../../../../../frontend/src/types";

const flow = (id: string, source: string, target: string): DiagramEdge => ({
  id,
  source,
  sourceHandle: "next",
  target,
  targetHandle: "prev",
});
const field = (id: string, source: string, target: string): DiagramEdge => ({
  id,
  source,
  sourceHandle: "field/image",
  target,
  targetHandle: "fieldInput/image",
});

describe("flow bridging on node delete", () => {
  it("joins the node before a deleted one to the node after it", () => {
    const edges = [flow("ab", "a", "b"), flow("bc", "b", "c")];
    const after = edgesAfterDeletingNodes(edges, new Set(["b"]));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ source: "a", sourceHandle: "next", target: "c", targetHandle: "prev" });
    expect(after[0]!.id).not.toBe("ab");
  });

  it("bridges over a run of consecutive deleted nodes with one edge", () => {
    const edges = [flow("ab", "a", "b"), flow("bc", "b", "c"), flow("cd", "c", "d")];
    const bridges = bridgeFlowEdges(edges, new Set(["b", "c"]));
    expect(bridges).toHaveLength(1);
    expect(bridges[0]).toMatchObject({ source: "a", target: "d" });
  });

  it("needs a neighbour on both sides", () => {
    expect(bridgeFlowEdges([flow("ab", "a", "b")], new Set(["b"]))).toEqual([]);
    expect(bridgeFlowEdges([flow("ab", "a", "b")], new Set(["a"]))).toEqual([]);
    // The chain ends inside the deleted set.
    expect(bridgeFlowEdges([flow("ab", "a", "b"), flow("bc", "b", "c")], new Set(["b", "c"]))).toEqual([]);
  });

  it("ignores field edges and drops every edge that touched the deleted node", () => {
    const edges = [flow("ab", "a", "b"), flow("bc", "b", "c"), field("xb", "x", "b"), field("by", "b", "y")];
    const after = edgesAfterDeletingNodes(edges, new Set(["b"]));
    expect(after.map((edge) => [edge.source, edge.target])).toEqual([["a", "c"]]);
  });

  it("does not duplicate an edge the ends already share", () => {
    const edges = [flow("ab", "a", "b"), flow("bc", "b", "c"), flow("ac", "a", "c")];
    expect(bridgeFlowEdges(edges, new Set(["b"]))).toEqual([]);
  });

  it("deleting a node outside the chain changes nothing", () => {
    const edges = [flow("ab", "a", "b")];
    expect(edgesAfterDeletingNodes(edges, new Set(["z"]))).toEqual(edges);
  });
});
