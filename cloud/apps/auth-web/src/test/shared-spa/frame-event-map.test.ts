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
  backForwardMinVersion,
  bindingConflicts,
  bindingOfRule,
  bindingRule,
  edgeGestures,
  frameActionKinds,
  frameActionKindsFor,
  frameActionTitle,
  frameActionUnavailableReason,
  frameActionValue,
  frameBindings,
  frameEventMapRules,
  frameGestureTitle,
  frameGestureValue,
  frameOffersEdgeGestures,
  frameSupportsBackForward,
  frameSupportsSceneSettings,
  frameSupportsSceneSwitcher,
  gestureCanVoiceChat,
  parseFrameActionValue,
  parseFrameGestureValue,
  reportedEventMapOf,
  sceneSettingsMinVersion,
  sceneSwitcherMinVersion,
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
    const all = { voiceChat: true, displayPower: true, sceneSwitcher: true, sceneSettings: true, backForward: true };
    expect(frameActionKindsFor(refreshHeld, all)).toEqual([...frameActionKinds, "voiceChat"]);
    expect(frameActionKindsFor(refreshHeld, { ...all, voiceChat: false })).toEqual(frameActionKinds);
    expect(frameActionKindsFor(doublePress, all)).toEqual(frameActionKinds);
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

  it("binds a press or a swipe in from an edge to the scene switcher, on a FrameOS that has it", () => {
    // docs/scene-switcher.md: up from the bottom of a touch screen, on every
    // touch preset; a key's press on any frame that wants one.
    const bottom = { edge: "bottom" };
    const rule: EventMapRule = { event: "edgeSwipe", match: bottom, emit: "sceneSwitcher", as: {} };
    expect(bindingRule({ gesture: bottom, action: { kind: "sceneSwitcher" } })).toEqual(rule);
    expect(bindingOfRule(rule)).toEqual({ gesture: bottom, action: { kind: "sceneSwitcher" } });
    expect(isEventMapRule(rule)).toBe(true);
    const refreshTwice = { label: "REFRESH", action: "doublePress" };
    expect(bindingRule({ gesture: refreshTwice, action: { kind: "sceneSwitcher" } })).toEqual({
      event: "button", match: refreshTwice, emit: "sceneSwitcher", as: {},
    });
    expect(frameActionTitle({ kind: "sceneSwitcher" })).toBe("Scene switcher");
    expect(parseFrameActionValue(frameActionValue({ kind: "sceneSwitcher" }))).toEqual({ kind: "sceneSwitcher" });
    // The edges' own swipes: next and previous scene, and the switcher.
    const right: EventMapRule = { event: "edgeSwipe", match: { edge: "right" }, emit: "setCurrentScene", as: { direction: "next" } };
    expect(bindingOfRule(right)).toEqual({ gesture: { edge: "right" }, action: { kind: "nextScene" } });
    expect(bindingOfRule({ event: "edgeSwipe", match: { edge: "middle" }, emit: "render", as: {} })).toBeNull();
    expect(bindingOfRule({ event: "edgeSwipe", match: { edge: "left", direction: "right" }, emit: "render", as: {} })).toBeNull();
    // Offered only where the frame's FrameOS shows it.
    const old = { voiceChat: false, displayPower: false, sceneSwitcher: false };
    expect(frameActionKindsFor(bottom, old)).not.toContain("sceneSwitcher");
    expect(frameActionKindsFor(bottom, { ...old, sceneSwitcher: true })).toContain("sceneSwitcher");
    expect(frameActionUnavailableReason({ gesture: bottom, action: { kind: "sceneSwitcher" } }, old)).toBe(
      `needs FrameOS ${sceneSwitcherMinVersion}`,
    );
    expect(frameSupportsSceneSwitcher(sceneSwitcherMinVersion, true)).toBe(true);
    expect(frameSupportsSceneSwitcher("2026.10.20", true)).toBe(false);
    expect(frameSupportsSceneSwitcher(null, true)).toBe(false);
    expect(frameSupportsSceneSwitcher(null, false)).toBe(true);
    // A swipe is never a voice key.
    expect(gestureCanVoiceChat(bottom)).toBe(false);
  });

  it("binds a swipe down from the top to the scene's settings, on a FrameOS that has them", () => {
    // docs/scene-settings.md: down from the top of a touch screen, on every touch preset.
    const top = { edge: "top" };
    const rule: EventMapRule = { event: "edgeSwipe", match: top, emit: "sceneSettings", as: {} };
    expect(bindingRule({ gesture: top, action: { kind: "sceneSettings" } })).toEqual(rule);
    expect(bindingOfRule(rule)).toEqual({ gesture: top, action: { kind: "sceneSettings" } });
    expect(isEventMapRule(rule)).toBe(true);
    expect(frameActionTitle({ kind: "sceneSettings" })).toBe("Scene settings");
    expect(parseFrameActionValue(frameActionValue({ kind: "sceneSettings" }))).toEqual({ kind: "sceneSettings" });
    const old = { voiceChat: false, displayPower: false, sceneSettings: false };
    expect(frameActionKindsFor(top, old)).not.toContain("sceneSettings");
    expect(frameActionKindsFor(top, { ...old, sceneSettings: true })).toContain("sceneSettings");
    expect(frameActionUnavailableReason({ gesture: top, action: { kind: "sceneSettings" } }, old)).toBe(
      `needs FrameOS ${sceneSettingsMinVersion}`,
    );
    expect(frameSupportsSceneSettings(sceneSettingsMinVersion, true)).toBe(true);
    expect(frameSupportsSceneSettings("2026.10.20", true)).toBe(false);
    expect(frameSupportsSceneSettings(null, false)).toBe(true);
  });

  it("binds the swipes in from the sides to back and forward, on a FrameOS that has them", () => {
    // docs/events.md: the scene's own back and forward, never a scene switch;
    // every touch preset ships them on the left and the right edge.
    const left = { edge: "left" };
    const right = { edge: "right" };
    const back: EventMapRule = { event: "edgeSwipe", match: left, emit: "back", as: {} };
    const forward: EventMapRule = { event: "edgeSwipe", match: right, emit: "forward", as: {} };
    expect(bindingRule({ gesture: left, action: { kind: "back" } })).toEqual(back);
    expect(bindingRule({ gesture: right, action: { kind: "forward" } })).toEqual(forward);
    expect(bindingOfRule(back)).toEqual({ gesture: left, action: { kind: "back" } });
    expect(bindingOfRule(forward)).toEqual({ gesture: right, action: { kind: "forward" } });
    expect(isEventMapRule(back)).toBe(true);
    expect(frameActionTitle({ kind: "back" })).toBe("Back");
    expect(frameActionTitle({ kind: "forward" })).toBe("Forward");
    expect(parseFrameActionValue(frameActionValue({ kind: "forward" }))).toEqual({ kind: "forward" });
    // A key may say them too.
    expect(bindingRule({ gesture: leftHeld, action: { kind: "back" } })).toEqual({ event: "button", match: leftHeld, emit: "back", as: {} });
    const old = { voiceChat: false, displayPower: false, backForward: false };
    expect(frameActionKindsFor(left, old)).not.toContain("back");
    expect(frameActionKindsFor(left, { ...old, backForward: true })).toEqual(["nextScene", "prevScene", "back", "forward", "render"]);
    expect(frameActionUnavailableReason({ gesture: left, action: { kind: "back" } }, old)).toBe(
      `needs FrameOS ${backForwardMinVersion}`,
    );
    expect(frameSupportsBackForward(backForwardMinVersion, true)).toBe(true);
    expect(frameSupportsBackForward("2026.10.22", true)).toBe(false);
    expect(frameSupportsBackForward(null, false)).toBe(true);
  });

  it("offers the edges as rows on a touch screen, by select value and title", () => {
    expect(edgeGestures()).toEqual([{ edge: "left" }, { edge: "right" }, { edge: "top" }, { edge: "bottom" }]);
    for (const gesture of [...edgeGestures(), leftHeld]) {
      expect(parseFrameGestureValue(frameGestureValue(gesture))).toEqual(gesture);
    }
    expect(parseFrameGestureValue(JSON.stringify({ edge: "middle" }))).toBeNull();
    expect(frameGestureTitle({ edge: "bottom" })).toBe("Swipe up from the bottom");
    expect(frameGestureTitle(leftHeld)).toBe("LEFT · long press");
    expect(frameOffersEdgeGestures(true, "embedded", [])).toBe(true);
    expect(frameOffersEdgeGestures(null, "pimoroni.hyperpixel4sq_touch", [])).toBe(true);
    expect(frameOffersEdgeGestures(null, "lcd.st7701s_480x480", [])).toBe(true);
    expect(frameOffersEdgeGestures(null, "waveshare.EPD_7in5_V2", presetRules)).toBe(false);
    // A map that binds an edge already shows it as a row, whatever the device.
    expect(frameOffersEdgeGestures(null, null, [{ event: "edgeSwipe", match: { edge: "left" }, emit: "render", as: {} }])).toBe(true);
    // The same swipe twice is a conflict, as a press is.
    const twice = frameBindings([
      { event: "edgeSwipe", match: { edge: "bottom" }, emit: "sceneSwitcher", as: {} },
      { event: "edgeSwipe", match: { edge: "bottom" }, emit: "render", as: {} },
    ]).bindings;
    expect(bindingConflicts(twice)).toEqual(["Swipe up from the bottom is bound twice; only the first binding counts"]);
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
      "back", "forward", "render", "sceneSettings", "sceneSwitcher", "setCurrentScene", "setSceneState", "toggleScreen", "turnOff", "turnOn",
      "voiceChat",
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
