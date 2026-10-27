// "Button actions" (frontend/src/utils/frameEventMap.ts): the frame's event
// map (docs/events.md, "Event map") as rows of one press and one action, and
// back into the rules the device's dispatcher applies — a rule with `emit`
// replaces the press, so the scene never hears it. Round trip pinned here;
// what a rule MEANS is the dispatcher corpus's (docs/event-fixtures.json).
import { describe, expect, it } from "vitest";
import type { EventMapRule } from "../../../../../../frontend/src/types";
import {
  cloudEventMapPayload,
  eventMapEmits,
  isEventMapRule,
} from "../../../../../../frontend/src/utils/cloudFrameSettings";
import {
  bindingConflicts,
  bindingOfRule,
  bindingRule,
  frameActionKinds,
  frameActionKindsFor,
  frameActionTitle,
  frameActionUnavailableReason,
  frameActionValue,
  frameBindings,
  frameEventMapRules,
  gestureCanVoiceChat,
  parseFrameActionValue,
  reportedEventMapOf,
} from "../../../../../../frontend/src/utils/frameEventMap";

// The reTerminal preset: the arrows held walk the scenes.
const leftHeld = { label: "LEFT", action: "longPress" };
const rightHeld = { label: "RIGHT", action: "longPress" };
const presetRules: EventMapRule[] = [
  { event: "button", match: leftHeld, emit: "setCurrentScene", as: { direction: "prev" } },
  { event: "button", match: rightHeld, emit: "setCurrentScene", as: { direction: "next" } },
];

describe("bindings and rules", () => {
  it("writes the preset's rules for previous and next scene", () => {
    expect(bindingRule({ gesture: leftHeld, action: { kind: "prevScene" } })).toEqual(presetRules[0]);
    expect(bindingRule({ gesture: rightHeld, action: { kind: "nextScene" } })).toEqual(presetRules[1]);
  });

  it("writes a scene switch by id, a refresh and the display switches", () => {
    const press = { label: "REFRESH", action: "doublePress" };
    expect(bindingRule({ gesture: press, action: { kind: "showScene", sceneId: "clock" } })).toEqual({
      event: "button", match: press, emit: "setCurrentScene", as: { sceneId: "clock" },
    });
    expect(bindingRule({ gesture: press, action: { kind: "render" } })).toEqual({ event: "button", match: press, emit: "render", as: {} });
    expect(bindingRule({ gesture: press, action: { kind: "turnOff" } }).emit).toBe("turnOff");
  });

  it("binds a long press to the voice chat, and offers that to long presses on a frame with a microphone", () => {
    // docs/voice-chat.md: the firmware reads this rule off the map and opens the
    // microphone while the key is held; the reTerminal E1001/E1002 presets ship it.
    const refreshHeld = { label: "REFRESH", action: "longPress" };
    const rule: EventMapRule = { event: "button", match: refreshHeld, emit: "voiceChat", as: {} };
    expect(bindingRule({ gesture: refreshHeld, action: { kind: "voiceChat" } })).toEqual(rule);
    expect(bindingOfRule(rule)).toEqual({ gesture: refreshHeld, action: { kind: "voiceChat" } });
    expect(frameActionTitle({ kind: "voiceChat" })).toBe("Voice chat");
    expect(parseFrameActionValue(frameActionValue({ kind: "voiceChat" }))).toEqual({ kind: "voiceChat" });
    // The contract lets the map emit it, so a push carries it.
    expect(eventMapEmits).toContain("voiceChat");
    expect(isEventMapRule(rule)).toBe(true);
    // Offered for a long press when the frame has voice chat, never for a press
    // or a double press: the release is what ends a sentence.
    const doublePress = { label: "REFRESH", action: "doublePress" };
    expect(frameActionKindsFor(refreshHeld, { voiceChat: true, displayPower: true })).toEqual([...frameActionKinds, "voiceChat"]);
    expect(frameActionKindsFor(refreshHeld, { voiceChat: false, displayPower: true })).toEqual(frameActionKinds);
    expect(frameActionKindsFor(doublePress, { voiceChat: true, displayPower: true })).toEqual(frameActionKinds);
    expect(gestureCanVoiceChat(refreshHeld)).toBe(true);
    expect(gestureCanVoiceChat(doublePress)).toBe(false);
    expect(frameActionKinds).not.toContain("voiceChat");
    // A saved rule on another press is shown with why, and named as doing nothing.
    const onDouble = { gesture: doublePress, action: { kind: "voiceChat" as const } };
    expect(frameActionUnavailableReason(onDouble, { voiceChat: true, displayPower: true })).toBe("long press only");
    expect(frameActionUnavailableReason({ gesture: refreshHeld, action: { kind: "voiceChat" } }, { voiceChat: true, displayPower: true })).toBeNull();
    expect(bindingConflicts([onDouble])).toEqual([
      "REFRESH · double press is bound to Voice chat, which only a long press starts: the frame listens while the key is held and stops when it is let go, so this press does nothing",
    ]);
  });

  it("offers the display switches only where the driver powers the panel", () => {
    // docs/events.md, the host table: e-paper and every ESP32 board switch nothing on turnOn / turnOff.
    const offer = { voiceChat: false, displayPower: false };
    expect(frameActionKindsFor(leftHeld, offer)).toEqual(["nextScene", "prevScene", "render"]);
    const off = { gesture: leftHeld, action: { kind: "turnOff" as const } };
    expect(frameActionUnavailableReason(off, offer)).toBe("not on this display");
    expect(frameActionUnavailableReason(off, { ...offer, displayPower: true })).toBeNull();
    expect(bindingConflicts([off], offer)).toEqual([
      "LEFT · long press is bound to Display off, but this display cannot be switched off and on; only the scene hears it",
    ]);
    expect(bindingConflicts([off])).toEqual([]);
    expect(bindingConflicts([off], { ...offer, displayPower: true })).toEqual([]);
  });

  it("reads its own rules back and keeps what it did not write", () => {
    const rewrite: EventMapRule = { event: "button", match: { label: "REFRESH", action: "press" }, as: { label: "A" } };
    const handMade: EventMapRule = { event: "gpio", match: { pin: 3 }, emit: "render", as: {} };
    // The device takes a nested `as` (a setSceneState emit's state); the SPA only keeps such a rule.
    const state = { event: "button", match: leftHeld, emit: "setSceneState", as: { state: { page: 2 } } } as unknown as EventMapRule;
    const { bindings, others } = frameBindings([...presetRules, rewrite, handMade, state]);
    expect(bindings).toEqual([
      { gesture: leftHeld, action: { kind: "prevScene" } },
      { gesture: rightHeld, action: { kind: "nextScene" } },
    ]);
    expect(others).toEqual([rewrite, handMade, state]);
    expect(frameEventMapRules(bindings, others)).toEqual([...presetRules, rewrite, handMade, state]);
    // A direction with extra baggage, or a match on more than one press, is not a row.
    expect(bindingOfRule({ event: "button", match: leftHeld, emit: "setCurrentScene", as: { direction: "prev", state: "{}" } })).toBeNull();
    expect(bindingOfRule({ event: "button", match: { label: "LEFT", action: "longPress", wake: true }, emit: "render", as: {} })).toBeNull();
    expect(bindingOfRule({ event: "button", match: leftHeld, emit: "setCurrentScene", as: { sceneId: "clock" } })).toEqual({
      gesture: leftHeld, action: { kind: "showScene", sceneId: "clock" },
    });
  });

  it("round-trips an action through its select value and names it", () => {
    for (const action of [{ kind: "nextScene" as const }, { kind: "render" as const }, { kind: "showScene" as const, sceneId: "clock" }]) {
      expect(parseFrameActionValue(frameActionValue(action))).toEqual(action);
    }
    expect(parseFrameActionValue("showScene:")).toBeNull();
    expect(parseFrameActionValue("reboot")).toBeNull();
    expect(frameActionTitle({ kind: "prevScene" })).toBe("Previous scene");
    expect(frameActionTitle({ kind: "showScene", sceneId: "clock" }, [{ id: "clock", name: "Clock" }])).toBe("Show scene: Clock");
    expect(frameActionTitle({ kind: "showScene", sceneId: "gone" }, [])).toBe("Show scene: gone");
  });

  it("names a press bound twice", () => {
    const { bindings } = frameBindings([...presetRules, { event: "button", match: leftHeld, emit: "render", as: {} }]);
    expect(bindingConflicts(bindings)).toEqual(["LEFT · long press is bound twice; only the first binding counts"]);
    expect(bindingConflicts(frameBindings(presetRules).bindings)).toEqual([]);
  });
});

describe("the rules a device or a push carries", () => {
  it("accepts what the dispatcher reads and refuses what it would skip", () => {
    expect(isEventMapRule(presetRules[0])).toBe(true);
    expect(isEventMapRule({ event: "button", as: { label: "A" } })).toBe(true);
    expect(isEventMapRule({ event: "button", emit: "render" })).toBe(true);
    expect(isEventMapRule({ event: "button" })).toBe(false);
    expect(isEventMapRule({ event: "", as: {} })).toBe(false);
    expect(isEventMapRule({ event: "button", match: "LEFT", as: {} })).toBe(false);
    expect(isEventMapRule({ event: "button", emit: "reboot" })).toBe(false);
    expect(isEventMapRule("nonsense")).toBe(false);
    // The emits are the contract's: what the eventMap origin may say.
    expect([...eventMapEmits].sort()).toEqual([
      "render", "setCurrentScene", "setSceneState", "toggleScreen", "turnOff", "turnOn", "voiceChat",
    ]);
  });

  it("builds a push the contract accepts, non-rules dropped and `as` always an object", () => {
    expect(cloudEventMapPayload(undefined)).toBeUndefined();
    expect(cloudEventMapPayload("x")).toBeUndefined();
    expect(cloudEventMapPayload([])).toEqual([]);
    expect(cloudEventMapPayload([...presetRules, { event: "button", emit: "render" }, { event: "button" }, 1])).toEqual([
      ...presetRules,
      { event: "button", emit: "render", as: {} },
    ]);
  });

  it("reads the device's report, malformed entries dropped, none as null", () => {
    expect(reportedEventMapOf(undefined)).toBeNull();
    expect(reportedEventMapOf(null)).toBeNull();
    expect(reportedEventMapOf([])).toEqual([]);
    expect(reportedEventMapOf([...presetRules, { nope: true }])).toEqual(presetRules);
  });
});
