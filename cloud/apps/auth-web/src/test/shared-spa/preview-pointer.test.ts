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
