// The frontend's subscriptions() wrapper (frontend/src/utils/keaSubscriptions)
// against the failure the store workspace hit: kea-subscriptions records a
// subscription in a closure of the built logic object and drops it in THAT
// object's beforeUnmount, while kea counts mounts per path. React's
// StrictMode effect replay re-mounts a built object kea already dropped from
// its cache; the next render builds a fresh object for the same path, and
// the last unmount runs the fresh object's beforeUnmount — the old object's
// subscription survived, and fired against the next instance's state (the
// diagram's `edges` subscription wrote `[]` into the frame form: v4 → v5
// showed no edges). kea itself must come from the frontend's node_modules:
// the wrapper resolves it from there, and one context must see both.
import { beforeEach, describe, expect, it } from "vitest";
import {
  actions,
  getPluginContext,
  kea,
  key,
  path,
  props,
  reducers,
  resetContext,
  type MakeLogicType,
} from "../../../../../../frontend/node_modules/kea";
import { subscriptionsPlugin } from "../../../../../../frontend/node_modules/kea-subscriptions";
import { subscriptions } from "../../../../../../frontend/src/utils/keaSubscriptions";

type Seen = [id: string, value: unknown, lastValue: unknown];
type EdgesLogicType = MakeLogicType<
  { edges: string[] },
  { setEdges: (edges: string[]) => { edges: string[] } },
  { id: string }
>;

function registeredFor(pathString: string): number {
  const registered = getPluginContext<{ subscriptions: Set<{ logic: { pathString: string } }> }>(
    "subscriptions",
  ).subscriptions;
  return Array.from(registered).filter((entry) => entry.logic.pathString === pathString).length;
}

describe("frontend subscriptions() wrapper", () => {
  const seen: Seen[] = [];
  const edgesLogic = kea<EdgesLogicType>([
    path(["test", "edgesLogic"]),
    props({} as { id: string }),
    key((logicProps) => logicProps.id),
    actions({ setEdges: (edges: string[]) => ({ edges }) }),
    reducers({ edges: [[] as string[], { setEdges: (_, { edges }) => edges }] }),
    subscriptions<EdgesLogicType>(({ props: logicProps }) => ({
      edges: (value: unknown, lastValue: unknown) => {
        seen.push([logicProps.id, value, lastValue]);
      },
    })),
  ]);

  beforeEach(() => {
    resetContext({ plugins: [subscriptionsPlugin] });
    seen.length = 0;
  });

  it("drops a dropped object's subscriptions with the path, so a fresh instance starts clean", () => {
    const first = edgesLogic({ id: "x" });
    const unmountFirst = first.mount();
    first.actions.setEdges(["a"]);
    expect(seen).toEqual([
      ["x", [], undefined],
      ["x", ["a"], []],
    ]);
    expect(registeredFor("test.edgesLogic.x")).toBe(1);

    // StrictMode's replay: the effect cleanup unmounts (kea drops the object
    // from its cache)…
    unmountFirst();
    expect(registeredFor("test.edgesLogic.x")).toBe(0);
    // …and the effect re-run mounts the same, dropped, object again.
    const unmountStale = first.mount();
    expect(registeredFor("test.edgesLogic.x")).toBe(1);
    // The next render builds a fresh object for the path; mounting it is a
    // second mount — no afterMount, no subscription of its own.
    const second = edgesLogic({ id: "x" });
    expect(second).not.toBe(first);
    const unmountSecond = second.mount();
    expect(registeredFor("test.edgesLogic.x")).toBe(1);

    // The last unmount is the fresh object's. kea-subscriptions alone would
    // leave the old object's subscription registered here.
    unmountStale();
    unmountSecond();
    expect(registeredFor("test.edgesLogic.x")).toBe(0);

    // A later instance sees only its own subscription: nothing stale fires
    // with an old lastValue against its (empty) state.
    seen.length = 0;
    const third = edgesLogic({ id: "x" });
    const unmountThird = third.mount();
    expect(registeredFor("test.edgesLogic.x")).toBe(1);
    third.actions.setEdges(["b"]);
    expect(seen).toEqual([
      ["x", [], undefined],
      ["x", ["b"], []],
    ]);
    unmountThird();
    expect(registeredFor("test.edgesLogic.x")).toBe(0);
  });

  it("leaves other instances' subscriptions alone", () => {
    const x = edgesLogic({ id: "x" });
    const y = edgesLogic({ id: "y" });
    const unmountX = x.mount();
    const unmountY = y.mount();
    expect(registeredFor("test.edgesLogic.x")).toBe(1);
    expect(registeredFor("test.edgesLogic.y")).toBe(1);
    unmountX();
    expect(registeredFor("test.edgesLogic.x")).toBe(0);
    expect(registeredFor("test.edgesLogic.y")).toBe(1);
    y.actions.setEdges(["c"]);
    expect(seen.filter(([id]) => id === "y")).toEqual([
      ["y", [], undefined],
      ["y", ["c"], []],
    ]);
    unmountY();
  });
});
