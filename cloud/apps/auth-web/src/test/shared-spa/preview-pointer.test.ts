import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as packagePointer from "frameos-wasm";
import * as frontendPointer from "../../../../../../frontend/src/utils/previewPointer";

// Pointer input reaches the browser preview from two pages: the scene store
// (through the frameos-wasm package, frameos/wasm/src/pointer.ts) and the
// self-hosted frontend's preview (frontend/src/utils/previewPointer.ts, which
// drives the worker itself and does not depend on the package). Both promise
// a scene the events a frame's evdev driver sends — `mouseMove` 0..32767, then
// `mouseDown` / `mouseUp` with the DRIVER's button numbers — so they are one
// file kept twice. This holds them together, and holds both to the numbers
// frameos/src/drivers/evdev/translate.nim uses.

const repoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../../../${path}`, import.meta.url)), "utf8");

// Everything below the header comment: the two files explain who they are
// for differently, and one doc comment names its own sink.
function body(source: string): string {
  return source
    .slice(source.indexOf("/** Both axes"))
    .replace(/\/\*\* Where pointer events go:.*\*\/\n/, "");
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

function pointer(type: string, init: Record<string, number>) {
  return Object.assign(new Event(type, { cancelable: true }), { button: -1, buttons: 0, pointerId: 1, ...init });
}

const script: Array<[string, Record<string, number>]> = [
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

function run(attach: typeof packagePointer.attachPointerInput): Array<[string, Record<string, number>]> {
  const sent: Array<[string, Record<string, number>]> = [];
  const canvas = new FakeCanvas();
  attach(canvas as unknown as HTMLCanvasElement, (name, payload) => sent.push([name, payload]));
  for (const [type, init] of script) {
    canvas.dispatchEvent(pointer(type, init));
  }
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
    const fromPackage = run(packagePointer.attachPointerInput);
    expect(run(frontendPointer.attachPointerInput)).toEqual(fromPackage);
    expect(fromPackage).toEqual([
      // The picture is 500x300, 100px down its box: its top-left corner.
      ["mouseMove", { x: 0, y: 0 }],
      ["mouseMove", { x: 16384, y: 16384 }],
      ["mouseDown", { button: 0 }],
      // A captured drag that left the picture stays on its edge.
      ["mouseMove", { x: 32767, y: 0 }],
      // The middle button (DOM 1) is the driver's 2, down and up again.
      ["mouseMove", { x: 17039, y: 20752 }],
      ["mouseDown", { button: 2 }],
      ["mouseMove", { x: 17039, y: 20752 }],
      ["mouseUp", { button: 2 }],
      ["mouseMove", { x: 32767, y: 32767 }],
      ["mouseUp", { button: 0 }],
      // The right button (DOM 2) is the driver's 1; a cancel lets it go.
      ["mouseMove", { x: 3932, y: 9830 }],
      ["mouseDown", { button: 1 }],
      ["mouseUp", { button: 1 }],
      // A button the driver has no name for is not an event.
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
    expect(repoFile("frameos/src/drivers/evdev/pointer.nim")).toContain(
      `const PointerRange* = ${packagePointer.POINTER_AXIS_MAX}`,
    );
    expect(repoFile("frameos/src/frameos/utils/image.nim")).toContain(
      `const PointerAxisMax* = ${packagePointer.POINTER_AXIS_MAX}`,
    );
  });
});
