// "Map buttons" (frontend/src/utils/sceneEventMap.ts): the scene's `button`
// listeners and the frame's buttons become the dialog's rows and choices, and
// the choices become the installed scene's `eventMap` (docs/events.md, "Event
// map") — the rules the device's dispatcher applies. Round trip pinned here;
// what a rule MEANS is the dispatcher corpus's (docs/event-fixtures.json).
import { describe, expect, it } from "vitest";
import type { EventMapRule, FrameScene, FrameType } from "../../../../../../frontend/src/types";
import {
  buttonGestures,
  buttonMapChoices,
  buttonMapConflicts,
  buttonMapRules,
  buttonsHeardAsIs,
  frameButtons,
  gestureValue,
  sceneButtonListeners,
  withSceneEventMap,
  withoutSceneEventMap,
} from "../../../../../../frontend/src/utils/sceneEventMap";

const eventNode = (id: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id,
  type: "event",
  position: { x: 0, y: 0 },
  data: { keyword: "button", config, ...extra },
});

// A store scene written for an Inky's A–D, plus a listener that hears every
// button (no row), a role listener and a duplicate.
const scene = {
  id: "clock",
  name: "Clock",
  edges: [],
  nodes: [
    eventNode("e1", { label: "A" }),
    eventNode("e2", { label: "B", action: "press" }),
    eventNode("e3", { role: "next" }),
    eventNode("e4", {}),
    eventNode("e5", { label: "A" }),
    eventNode("e6", {}, { label: "D" }),
    { id: "r", type: "event", position: { x: 0, y: 0 }, data: { keyword: "render" } },
  ],
} as unknown as FrameScene;

// A reTerminal: REFRESH, LEFT, RIGHT.
const frame = {
  id: 1,
  gpio_buttons: [
    { pin: 3, label: "REFRESH" },
    { pin: 4, label: "LEFT" },
    { pin: 5, label: "RIGHT", role: "menu" },
  ],
} as unknown as FrameType;

describe("sceneButtonListeners", () => {
  it("is one row per distinct key the scene names, old data.label included, and none for an unfiltered listener", () => {
    const listeners = sceneButtonListeners(scene);
    expect(listeners.map((listener) => listener.title)).toEqual(["A", "B · press", "next (role)", "D"]);
    expect(listeners[1]).toMatchObject({ identity: { label: "B" }, action: "press" });
    expect(listeners[2]).toMatchObject({ identity: { role: "next" } });
  });
});

describe("frameButtons", () => {
  it("gives every button its configured role, else the contract's default for its label", () => {
    expect(frameButtons(frame)).toEqual([
      { pin: 3, label: "REFRESH", role: "refresh" },
      { pin: 4, label: "LEFT", role: "prev" },
      { pin: 5, label: "RIGHT", role: "menu" },
    ]);
  });

  it("prefers the form's list, then the device's fixed buttons, then what the frame reported", () => {
    const inky = { id: 2, device: "pimoroni.inky_impression_7_3" } as unknown as FrameType;
    expect(frameButtons(inky).map((button) => button.label)).toEqual(["A", "B", "C", "D"]);
    const reported = { id: 3, hardware: { gpioButtons: [{ pin: 9, label: "KEY1" }] } } as unknown as FrameType;
    expect(frameButtons(reported)).toEqual([{ pin: 9, label: "KEY1", role: "next" }]);
    expect(frameButtons(reported, { gpio_buttons: [{ pin: 1, label: "GO" }] }).map((b) => b.label)).toEqual(["GO"]);
  });

  it("says which buttons a listener hears without any map", () => {
    const [a, , next] = sceneButtonListeners(scene);
    const buttons = frameButtons(frame);
    expect(buttonsHeardAsIs(a!, buttons)).toEqual([]);
    expect(buttonsHeardAsIs(next!, buttons)).toEqual([]);
    expect(buttonsHeardAsIs(next!, frameButtons({ gpio_buttons: [{ pin: 5, label: "RIGHT" }] } as FrameType))).toEqual([
      { pin: 5, label: "RIGHT", role: "next" },
    ]);
  });
});

describe("rules from choices and back", () => {
  const listeners = sceneButtonListeners(scene);
  const buttons = frameButtons(frame);
  const refreshPress = gestureValue({ label: "REFRESH", action: "press" });
  const refreshLong = gestureValue({ label: "REFRESH", action: "longPress" });

  it("offers every press of every button", () => {
    expect(buttonGestures(buttons).slice(0, 4)).toEqual([
      { label: "REFRESH", action: "press" },
      { label: "REFRESH", action: "doublePress" },
      { label: "REFRESH", action: "longPress" },
      { label: "LEFT", action: "press" },
    ]);
  });

  it("writes one rule per mapped listener, with every field the listener filters on in `as`", () => {
    const rules = buttonMapRules(listeners, { [listeners[0]!.key]: refreshPress, [listeners[1]!.key]: refreshLong });
    expect(rules).toEqual([
      { event: "button", match: { label: "REFRESH", action: "press" }, as: { label: "A" } },
      { event: "button", match: { label: "REFRESH", action: "longPress" }, as: { label: "B", action: "press" } },
    ]);
  });

  it("reads its own rules back and keeps what it did not write", () => {
    const handMade: EventMapRule = { event: "gpio", match: { pin: 3 }, as: { pin: 5 } };
    const rules = [
      ...buttonMapRules(listeners, { [listeners[2]!.key]: refreshPress }),
      handMade,
      { event: "button", match: { label: "LEFT", action: "press", wake: true }, as: { label: "A" } },
    ];
    const { choices, custom } = buttonMapChoices(rules, listeners);
    expect(choices).toEqual({ [listeners[2]!.key]: refreshPress });
    expect(custom).toHaveLength(2);
    expect(buttonMapRules(listeners, choices, custom)).toEqual(rules);
  });

  it("names a press mapped twice", () => {
    expect(buttonMapConflicts(listeners, { [listeners[0]!.key]: refreshPress, [listeners[3]!.key]: refreshPress })).toEqual([
      "REFRESH · press is mapped to A and D",
    ]);
    expect(buttonMapConflicts(listeners, { [listeners[0]!.key]: refreshPress })).toEqual([]);
  });

  it("puts the rules on the scene beside its nodes, and takes them off for an export", () => {
    const rules = buttonMapRules(listeners, { [listeners[0]!.key]: refreshPress });
    const mapped = withSceneEventMap(scene, rules);
    expect(mapped.eventMap).toEqual(rules);
    expect(mapped.nodes).toBe(scene.nodes);
    expect(withSceneEventMap(mapped, [])).not.toHaveProperty("eventMap");
    expect(withoutSceneEventMap(mapped)).not.toHaveProperty("eventMap");
    expect(withoutSceneEventMap(scene)).toBe(scene);
  });
});
