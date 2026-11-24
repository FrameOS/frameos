import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as packagePointer from "frameos-wasm";
import * as frontendPointer from "../../../../../../frontend/src/utils/previewPointer";

// Input reaches the browser preview from two pages: the scene store (through
// the frameos-wasm package, frameos/wasm/src/pointer.ts) and the self-hosted
// frontend's preview (frontend/src/utils/previewPointer.ts, which drives the
// worker itself and does not depend on the package). Both promise a scene the
// events a frame's evdev driver sends — `pointerMove` / `pointerDown` /
// `pointerUp` 0..32767 with the DRIVER's button numbers, an id and a type;
// `mouseMove` / `mouseDown` / `mouseUp` for a bundle from before input v2;
// the keyboard as `keyDown` / `keyUp` / `textInput` — so they are one file kept
// twice. This holds them together, and holds both to the numbers
// frameos/src/drivers/evdev/translate.nim uses.

const repoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../../../${path}`, import.meta.url)), "utf8");

// Everything below the header comment: the two files explain who they are
// for differently, and one doc comment names its own sink.
function body(source: string): string {
  return source
    .slice(source.indexOf("/** Both axes"))
    .replace(/\/\*\* Where input events go:.*\*\/\n/, "");
}

class FakeCanvas extends EventTarget {
  width = 800;
  height = 480;
  setPointerCapture = vi.fn();
  // Letterboxed: a 5:3 picture in a square box.
  getBoundingClientRect() {
    return { height: 500, left: 40, top: 10, width: 500 };
  }
}

function pointer(type: string, init: Record<string, number | string>) {
  return Object.assign(new Event(type, { cancelable: true }), {
    button: -1,
    buttons: 0,
    pointerId: 1,
    pointerType: "mouse",
    ...init,
  });
}

const pointer_ = pointer;

const script: Array<[string, Record<string, number | string>]> = [
  ["pointermove", { clientX: 40, clientY: 110 }],
  ["pointerdown", { button: 0, buttons: 1, clientX: 290, clientY: 260 }],
  ["pointermove", { buttons: 1, clientX: 9999, clientY: -50 }],
  ["pointermove", { button: 1, buttons: 5, clientX: 300, clientY: 300 }],
  ["pointermove", { button: 1, buttons: 1, clientX: 300, clientY: 300 }],
  ["pointerup", { button: 0, clientX: 540, clientY: 410 }],
  ["pointerdown", { button: 2, buttons: 2, clientX: 100, clientY: 200 }],
  ["pointercancel", {}],
  ["pointerdown", { button: 7, buttons: 128, clientX: 100, clientY: 200 }],
];

type Sent = Array<[string, Record<string, unknown>]>;

function run(attach: typeof packagePointer.attachPointerInput, inputV2: boolean): Sent {
  const sent: Sent = [];
  const canvas = new FakeCanvas();
  attach(canvas as unknown as HTMLCanvasElement, (name, payload) => sent.push([name, payload]), {
    inputV2: () => inputV2,
  });
  for (const [type, init] of script) {
    canvas.dispatchEvent(pointer(type, init));
  }
  // A touch: its own pointer, and a cancel names it.
  canvas.dispatchEvent(pointer("pointerdown", { button: 0, buttons: 1, clientX: 100, clientY: 200, pointerId: 5, pointerType: "touch" }));
  canvas.dispatchEvent(pointer("pointercancel", { pointerId: 5, pointerType: "touch" }));
  // The wheel: a notch down, then a trackpad's slow scroll that adds up to one.
  canvas.dispatchEvent(Object.assign(new Event("wheel", { cancelable: true }), { clientX: 290, clientY: 260, deltaX: 0, deltaY: 100, deltaMode: 0 }));
  canvas.dispatchEvent(Object.assign(new Event("wheel", { cancelable: true }), { clientX: 290, clientY: 260, deltaX: 60, deltaY: 0, deltaMode: 0 }));
  canvas.dispatchEvent(Object.assign(new Event("wheel", { cancelable: true }), { clientX: 290, clientY: 260, deltaX: 60, deltaY: 0, deltaMode: 0 }));
  return sent;
}

function runKeys(attach: typeof packagePointer.attachKeyboardInput): Sent {
  const sent: Sent = [];
  const canvas = new FakeCanvas();
  attach(canvas as unknown as HTMLCanvasElement, (name, payload) => sent.push([name, payload]));
  const key = (type: string, init: Record<string, unknown>) =>
    Object.assign(new Event(type, { cancelable: true }), {
      code: "", key: "", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false,
      ...init,
    });
  canvas.dispatchEvent(key("keydown", { code: "KeyA", key: "A", shiftKey: true }));
  canvas.dispatchEvent(key("keydown", { code: "KeyA", key: "A", shiftKey: true, repeat: true }));
  canvas.dispatchEvent(key("keyup", { code: "KeyA", key: "A", shiftKey: true }));
  canvas.dispatchEvent(key("keydown", { code: "Enter", key: "Enter" }));
  canvas.dispatchEvent(key("keydown", { code: "KeyC", key: "c", ctrlKey: true }));
  const space = key("keydown", { code: "Space", key: " " });
  canvas.dispatchEvent(space);
  sent.push(["(space default prevented)", { prevented: space.defaultPrevented }]);
  canvas.dispatchEvent(key("keydown", { code: "Dead", key: "Dead" }));
  return sent;
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preview pointer input, package and frontend", () => {
  it("is one file kept twice", () => {
    expect(body(repoFile("frontend/src/utils/previewPointer.ts"))).toBe(body(repoFile("frameos/wasm/src/pointer.ts")));
  });

  it("sends a scene the same events from either page", () => {
    const fromPackage = run(packagePointer.attachPointerInput, true);
    expect(run(frontendPointer.attachPointerInput, true)).toEqual(fromPackage);
    const mouse = { pointerId: 0, pointerType: "mouse" };
    expect(fromPackage).toEqual([
      // The picture is 500x300, 100px down its box: its top-left corner.
      ["pointerMove", { x: 0, y: 0, ...mouse, buttons: 0 }],
      // A press carries its position too.
      ["pointerMove", { x: 16384, y: 16384, ...mouse, buttons: 1 }],
      ["pointerDown", { x: 16384, y: 16384, ...mouse, buttons: 1, button: 0 }],
      // A captured drag that left the picture stays on its edge.
      ["pointerMove", { x: 32767, y: 0, ...mouse, buttons: 1 }],
      // The middle button (DOM 1) is the driver's 2, down and up again; the
      // mask names what is held, in the driver's bits.
      ["pointerMove", { x: 17039, y: 20752, ...mouse, buttons: 5 }],
      ["pointerDown", { x: 17039, y: 20752, ...mouse, buttons: 5, button: 2 }],
      ["pointerMove", { x: 17039, y: 20752, ...mouse, buttons: 1 }],
      ["pointerUp", { x: 17039, y: 20752, ...mouse, buttons: 1, button: 2 }],
      ["pointerMove", { x: 32767, y: 32767, ...mouse, buttons: 0 }],
      ["pointerUp", { x: 32767, y: 32767, ...mouse, buttons: 0, button: 0 }],
      // The right button (DOM 2) is the driver's 1; a cancel lets it go.
      ["pointerMove", { x: 3932, y: 9830, ...mouse, buttons: 2 }],
      ["pointerDown", { x: 3932, y: 9830, ...mouse, buttons: 2, button: 1 }],
      ["pointerCancel", { x: 3932, y: 9830, ...mouse }],
      // A button the driver has no name for is not an event.
      // A finger is its own pointer.
      ["pointerMove", { x: 3932, y: 9830, pointerId: 5, pointerType: "touch", buttons: 1 }],
      ["pointerDown", { x: 3932, y: 9830, pointerId: 5, pointerType: "touch", buttons: 1, button: 0 }],
      ["pointerCancel", { x: 3932, y: 9830, pointerId: 5, pointerType: "touch" }],
      // The wheel, in notches, at the pointer.
      ["wheel", { deltaX: 0, deltaY: 1, x: 16384, y: 16384 }],
      ["wheel", { deltaX: 1, deltaY: 0, x: 16384, y: 16384 }],
    ]);
  });

  it("keeps where a drag passed while a frame waited, in points", () => {
    // A drawing scene keeps every point of a stroke: moves the page queued
    // for one animation frame, and the browser's own coalesced ones, go with
    // the move that is sent, oldest first, as a frame's coalesced move says.
    const drag = (attach: typeof packagePointer.attachPointerInput): Sent => {
      const sent: Sent = [];
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
      const canvas = new FakeCanvas();
      attach(canvas as unknown as HTMLCanvasElement, (name, payload) => sent.push([name, payload]), {
        inputV2: () => true,
      });
      canvas.dispatchEvent(pointer("pointerdown", { button: 0, buttons: 1, clientX: 40, clientY: 110 }));
      canvas.dispatchEvent(pointer("pointermove", { buttons: 1, clientX: 90, clientY: 110 }));
      const coalesced = pointer("pointermove", { buttons: 1, clientX: 190, clientY: 110 });
      Object.assign(coalesced, {
        getCoalescedEvents: () => [{ clientX: 140, clientY: 110 }, { clientX: 190, clientY: 110 }],
      });
      canvas.dispatchEvent(coalesced);
      frames.splice(0).forEach((callback) => callback(0));
      return sent.filter(([name]) => name === "pointerMove");
    };
    const fromPackage = drag(packagePointer.attachPointerInput);
    expect(drag(frontendPointer.attachPointerInput)).toEqual(fromPackage);
    const mouse = { pointerId: 0, pointerType: "mouse" };
    expect(fromPackage).toEqual([
      ["pointerMove", { x: 0, y: 0, ...mouse, buttons: 1 }],
      ["pointerMove", { x: 9830, y: 0, ...mouse, buttons: 1, points: [3277, 0, 6553, 0] }],
    ]);
  });

  it("never leaves a scene holding a press the page let go of", () => {
    // The editor's preview dragged a list, let go off the canvas and came
    // back: the scene was still dragging (2026-11-07). Each way a release can
    // go missing ends the press, from either page.
    const lost = (attach: typeof packagePointer.attachPointerInput): Sent => {
      const sent: Sent = [];
      const canvas = new FakeCanvas();
      const into = (name: string, payload: Record<string, unknown>) => sent.push([name, payload]);
      let detach = attach(canvas as unknown as HTMLCanvasElement, into, { inputV2: () => true });
      // Released where the page never heard it: the next move holds nothing.
      canvas.dispatchEvent(pointer("pointerdown", { button: 0, buttons: 1, clientX: 290, clientY: 260 }));
      canvas.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 300, clientY: 260 }));
      // The capture lost mid-drag (the canvas hidden or replaced).
      canvas.dispatchEvent(pointer("pointerdown", { button: 0, buttons: 1, clientX: 290, clientY: 260 }));
      canvas.dispatchEvent(pointer("lostpointercapture", {}));
      // Its release after a pointerup is no second one.
      canvas.dispatchEvent(pointer("pointerdown", { button: 0, buttons: 1, clientX: 290, clientY: 260 }));
      canvas.dispatchEvent(pointer("pointerup", { button: 0, clientX: 290, clientY: 260 }));
      canvas.dispatchEvent(pointer("lostpointercapture", {}));
      // Detached with a finger down: it lets go.
      canvas.dispatchEvent(pointer("pointerdown", { button: 0, buttons: 1, clientX: 100, clientY: 200, pointerId: 5, pointerType: "touch" }));
      detach();
      detach = attach(canvas as unknown as HTMLCanvasElement, into, { inputV2: () => true });
      detach();
      return sent.filter(([name]) => name !== "pointerMove");
    };
    const fromPackage = lost(packagePointer.attachPointerInput);
    expect(lost(frontendPointer.attachPointerInput)).toEqual(fromPackage);
    const mouse = { pointerId: 0, pointerType: "mouse" };
    expect(fromPackage).toEqual([
      ["pointerDown", { x: 16384, y: 16384, ...mouse, buttons: 1, button: 0 }],
      ["pointerUp", { x: 17039, y: 16384, ...mouse, buttons: 0, button: 0 }],
      ["pointerDown", { x: 16384, y: 16384, ...mouse, buttons: 1, button: 0 }],
      ["pointerCancel", { x: 16384, y: 16384, ...mouse }],
      ["pointerDown", { x: 16384, y: 16384, ...mouse, buttons: 1, button: 0 }],
      ["pointerUp", { x: 16384, y: 16384, ...mouse, buttons: 0, button: 0 }],
      ["pointerDown", { x: 3932, y: 9830, pointerId: 5, pointerType: "touch", buttons: 1, button: 0 }],
      ["pointerCancel", { x: 3932, y: 9830, pointerId: 5, pointerType: "touch" }],
    ]);
  });

  it("gives a scene both fingers of a pinch, and keeps the page from zooming under them", () => {
    // Two fingers on a preview of a map scene zoomed the page instead (a
    // virtual frame's preview, 2026-11-16): the browser took the pinch and
    // cancelled both pointers. A touch panel reports two pointers; so does
    // the preview, and the page holds back while more than one is down.
    const pinch = (attach: typeof packagePointer.attachPointerInput): Sent => {
      const sent: Sent = [];
      const canvas = new FakeCanvas();
      attach(canvas as unknown as HTMLCanvasElement, (name, payload) => sent.push([name, payload]), {
        inputV2: () => true,
      });
      const touch = (type: string, count: number) => {
        const event = Object.assign(new Event(type, { cancelable: true }), { touches: { length: count } });
        canvas.dispatchEvent(event);
        sent.push([`(${type} ${count} prevented)`, { prevented: event.defaultPrevented }]);
      };
      const finger = { pointerType: "touch" };
      touch("touchstart", 1);
      canvas.dispatchEvent(pointer("pointerdown", { ...finger, pointerId: 7, button: 0, buttons: 1, clientX: 190, clientY: 160 }));
      touch("touchstart", 2);
      canvas.dispatchEvent(pointer("pointerdown", { ...finger, pointerId: 8, button: 0, buttons: 1, clientX: 390, clientY: 360 }));
      touch("touchmove", 2);
      canvas.dispatchEvent(pointer("pointermove", { ...finger, pointerId: 7, buttons: 1, clientX: 140, clientY: 110 }));
      canvas.dispatchEvent(pointer("pointermove", { ...finger, pointerId: 8, buttons: 1, clientX: 440, clientY: 410 }));
      canvas.dispatchEvent(pointer("pointerup", { ...finger, pointerId: 8, button: 0, clientX: 440, clientY: 410 }));
      touch("touchmove", 1);
      canvas.dispatchEvent(pointer("pointerup", { ...finger, pointerId: 7, button: 0, clientX: 140, clientY: 110 }));
      return sent;
    };
    const fromPackage = pinch(packagePointer.attachPointerInput);
    expect(pinch(frontendPointer.attachPointerInput)).toEqual(fromPackage);
    const a = { pointerId: 7, pointerType: "touch" };
    const b = { pointerId: 8, pointerType: "touch" };
    expect(fromPackage).toEqual([
      // One finger is the page's to scroll (the canvas's `touch-action: pan-y`).
      ["(touchstart 1 prevented)", { prevented: false }],
      ["pointerMove", { x: 9830, y: 5461, ...a, buttons: 1 }],
      ["pointerDown", { x: 9830, y: 5461, ...a, buttons: 1, button: 0 }],
      // Two are the scene's: a second pointer of its own.
      ["(touchstart 2 prevented)", { prevented: true }],
      ["pointerMove", { x: 22937, y: 27306, ...b, buttons: 1 }],
      ["pointerDown", { x: 22937, y: 27306, ...b, buttons: 1, button: 0 }],
      ["(touchmove 2 prevented)", { prevented: true }],
      // Spread apart, each with its own id (one queued move per pointer in
      // a frame: the second finger's is its release's position).
      ["pointerMove", { x: 6553, y: 0, ...a, buttons: 1 }],
      ["pointerMove", { x: 26214, y: 32767, ...b, buttons: 0 }],
      ["pointerUp", { x: 26214, y: 32767, ...b, buttons: 0, button: 0 }],
      // One finger left: the page's again.
      ["(touchmove 1 prevented)", { prevented: false }],
      ["pointerMove", { x: 6553, y: 0, ...a, buttons: 0 }],
      ["pointerUp", { x: 6553, y: 0, ...a, buttons: 0, button: 0 }],
    ]);
  });

  it("sends a bundle from before input v2 the old mouse events", () => {
    const fromPackage = run(packagePointer.attachPointerInput, false);
    expect(run(frontendPointer.attachPointerInput, false)).toEqual(fromPackage);
    expect(fromPackage).toEqual([
      ["mouseMove", { x: 0, y: 0 }],
      ["mouseMove", { x: 16384, y: 16384 }],
      ["mouseDown", { button: 0 }],
      ["mouseMove", { x: 32767, y: 0 }],
      ["mouseMove", { x: 17039, y: 20752 }],
      ["mouseDown", { button: 2 }],
      ["mouseMove", { x: 17039, y: 20752 }],
      ["mouseUp", { button: 2 }],
      ["mouseMove", { x: 32767, y: 32767 }],
      ["mouseUp", { button: 0 }],
      ["mouseMove", { x: 3932, y: 9830 }],
      ["mouseDown", { button: 1 }],
      ["mouseUp", { button: 1 }],
      // An old bundle has one pointer and no wheel.
      ["mouseMove", { x: 3932, y: 9830 }],
      ["mouseDown", { button: 0 }],
      ["mouseUp", { button: 0 }],
    ]);
  });

  it("sends the keyboard as the contract's keyDown / keyUp / textInput from either page", () => {
    const fromPackage = runKeys(packagePointer.attachKeyboardInput);
    expect(runKeys(frontendPointer.attachKeyboardInput)).toEqual(fromPackage);
    const flags = { shift: false, ctrl: false, alt: false, meta: false };
    expect(fromPackage).toEqual([
      ["keyDown", { code: "KeyA", key: "A", ...flags, shift: true, repeat: false }],
      ["textInput", { text: "A" }],
      ["keyDown", { code: "KeyA", key: "A", ...flags, shift: true, repeat: true }],
      ["textInput", { text: "A" }],
      ["keyUp", { code: "KeyA", key: "A", ...flags, shift: true }],
      ["keyDown", { code: "Enter", key: "Enter", ...flags, repeat: false }],
      // A chord types nothing.
      ["keyDown", { code: "KeyC", key: "c", ...flags, ctrl: true, repeat: false }],
      // A key that scrolls the page is the scene's while the picture has the focus.
      ["keyDown", { code: "Space", key: " ", ...flags, repeat: false }],
      ["textInput", { text: " " }],
      ["(space default prevented)", { prevented: true }],
      // A dead key waits for the next one; the browser says "Dead".
      ["keyDown", { code: "Dead", key: "Dead", ...flags, repeat: false }],
    ]);
  });

  it("hands the frame the computer's clipboard before a Ctrl/Cmd+V, from either page", () => {
    vi.useFakeTimers();
    try {
      for (const pointer of [packagePointer, frontendPointer]) {
        const sent: Array<[string, unknown]> = [];
        const canvas = new FakeCanvas();
        const detach = pointer.attachKeyboardInput(
          canvas as unknown as HTMLCanvasElement,
          (name, payload) => sent.push([name, payload]),
          { onPaste: (text) => sent.push(["(clipboard)", text]) },
        );
        const key = (init: Record<string, unknown>) =>
          Object.assign(new Event("keydown", { cancelable: true }), {
            code: "KeyV", key: "v", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
            repeat: false, isComposing: false, ...init,
          });
        const paste = (text: string) =>
          Object.assign(new Event("paste", { cancelable: true }), {
            clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") },
          });
        // The key waits for the browser's paste event, and goes after its text.
        canvas.dispatchEvent(key({ metaKey: true }));
        expect(sent).toEqual([]);
        const event = paste("from the computer");
        canvas.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(sent.map(([name]) => name)).toEqual(["(clipboard)", "keyDown"]);
        expect(sent[0]?.[1]).toBe("from the computer");
        expect(sent[1]?.[1]).toMatchObject({ code: "KeyV", meta: true });
        // Nothing to paste: no paste event, the key alone, soon.
        sent.length = 0;
        canvas.dispatchEvent(key({ ctrlKey: true }));
        expect(sent).toEqual([]);
        vi.advanceTimersByTime(150);
        expect(sent.map(([name]) => name)).toEqual(["keyDown"]);
        detach();
      }
      // Without onPaste the key goes at once, as before.
      const sent: Array<[string, unknown]> = [];
      const canvas = new FakeCanvas();
      packagePointer.attachKeyboardInput(canvas as unknown as HTMLCanvasElement, (name) => sent.push([name, null]));
      canvas.dispatchEvent(Object.assign(new Event("keydown"), { code: "KeyV", key: "v", ctrlKey: true }));
      expect(sent.map(([name]) => name)).toEqual(["keyDown"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // The frame's Copy lands on the computer's clipboard, and scene code (which
  // is anyone's on a store page) can move the frame's clipboard by itself:
  // only a press on the preview a moment ago makes it the person's Copy.
  it("writes the computer's clipboard only after a press on the preview, from either page", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const writeText = vi.fn((_text: string) => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      let clock = Date.UTC(2031, 0, 1);
      for (const pointer of [packagePointer, frontendPointer]) {
        // Long after any press an earlier test made.
        clock += 60 * 60 * 1000;
        vi.setSystemTime(clock);
        writeText.mockClear();
        expect(pointer.previewHasGesture()).toBe(false);
        pointer.writeHostClipboard("what a scene put there by itself");
        expect(writeText).not.toHaveBeenCalled();

        // A tap (the on-screen keyboard's Copy): the press and its release.
        const canvas = new FakeCanvas();
        const detachPointer = pointer.attachPointerInput(canvas as unknown as HTMLCanvasElement, () => undefined, {
          inputV2: () => true,
        });
        // The pointer passing over the picture is no press.
        canvas.dispatchEvent(pointer_("pointermove", { clientX: 290, clientY: 260 }));
        expect(pointer.previewHasGesture()).toBe(false);
        canvas.dispatchEvent(pointer_("pointerdown", { button: 0, buttons: 1, clientX: 290, clientY: 260 }));
        expect(pointer.previewHasGesture()).toBe(true);
        pointer.writeHostClipboard("copied");
        expect(writeText.mock.calls).toEqual([["copied"]]);
        vi.setSystemTime(clock + pointer.PREVIEW_GESTURE_MS + 1);
        pointer.writeHostClipboard("later, by itself");
        expect(writeText).toHaveBeenCalledTimes(1);
        canvas.dispatchEvent(pointer_("pointerup", { button: 0, clientX: 290, clientY: 260 }));
        pointer.writeHostClipboard("on the release");
        expect(writeText).toHaveBeenLastCalledWith("on the release");
        detachPointer();

        // Ctrl+C in a field: the key is the press.
        clock += 60 * 60 * 1000;
        vi.setSystemTime(clock);
        expect(pointer.previewHasGesture()).toBe(false);
        const detachKeys = pointer.attachKeyboardInput(canvas as unknown as HTMLCanvasElement, () => undefined);
        canvas.dispatchEvent(
          Object.assign(new Event("keydown", { cancelable: true }), {
            altKey: false, code: "KeyC", ctrlKey: true, isComposing: false, key: "c", metaKey: false, repeat: false,
            shiftKey: false,
          }),
        );
        pointer.writeHostClipboard("copied with the keyboard");
        expect(writeText).toHaveBeenLastCalledWith("copied with the keyboard");
        detachKeys();

        // Input the page is not forwarding (a bundle without it) is no press either.
        clock += 60 * 60 * 1000;
        vi.setSystemTime(clock);
        const off = pointer.attachPointerInput(canvas as unknown as HTMLCanvasElement, () => undefined, {
          enabled: () => false,
        });
        canvas.dispatchEvent(pointer_("pointerdown", { button: 0, buttons: 1, clientX: 290, clientY: 260 }));
        expect(pointer.previewHasGesture()).toBe(false);
        off();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the evdev driver's button numbers and range", () => {
    const driver = repoFile("frameos/src/drivers/evdev/translate.nim");
    for (const [name, button] of [
      ["BTN_LEFT", 0],
      ["BTN_RIGHT", 1],
      ["BTN_MIDDLE", 2],
      ["BTN_SIDE", 3],
      ["BTN_EXTRA", 4],
    ] as const) {
      expect(driver).toContain(`of ${name}: ${button}`);
    }
    // DOM: 0 main, 1 middle, 2 right, 3 back, 4 forward.
    expect([0, 1, 2, 3, 4].map(packagePointer.pointerButton)).toEqual([0, 2, 1, 3, 4]);
    // The range is the event contract's `pointer.wireMax`, generated for
    // every reader (docs/events-contract.json): the driver, the runner and
    // both TypeScript copies import it rather than spell it.
    expect(repoFile("frameos/src/frameos/events_gen.nim")).toContain(
      `PointerWireMax* = ${packagePointer.POINTER_AXIS_MAX}`,
    );
    expect(repoFile("frameos/src/drivers/evdev/pointer.nim")).toContain(
      "const PointerRange* = PointerWireMax",
    );
    expect(repoFile("frameos/src/frameos/utils/image.nim")).toContain(
      "const PointerAxisMax* = PointerWireMax",
    );
    expect(frontendPointer.POINTER_AXIS_MAX).toBe(packagePointer.POINTER_AXIS_MAX);
  });
});
