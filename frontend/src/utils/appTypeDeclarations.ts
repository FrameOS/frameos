import type { AppConfig, AppConfigField, AppConfigFieldType, MarkdownField } from '../types'
import { appContextMembers, eventTypeDeclarations } from './eventsContract.gen'
import { selectFieldValues } from './selectOptions'

const fieldTypeToTsType: Record<AppConfigFieldType, string> = {
  string: 'string',
  text: 'string',
  float: 'number',
  integer: 'number',
  boolean: 'boolean',
  color: 'string',
  date: 'string',
  json: 'any',
  node: 'number',
  scene: 'string',
  image: 'any',
  font: 'string',
  path: 'string',
  select: 'string',
}

function isAppConfigField(field: AppConfigField | MarkdownField): field is AppConfigField {
  return 'name' in field
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
}

function literalString(value: string): string {
  return JSON.stringify(value)
}

function fieldTsType(field: AppConfigField): string {
  if (field.type === 'select') {
    const values = selectFieldValues(field.options)
    if (values.length > 0) {
      return values.map(literalString).join(' | ')
    }
  }
  return fieldTypeToTsType[field.type] ?? 'any'
}

function optionalMarker(field: AppConfigField): string {
  return field.required || field.value !== undefined ? '' : '?'
}

export function buildAppTypeDeclarations(config: Partial<AppConfig> | null | undefined): string {
  const fieldNames = new Set<string>()
  const fields = (config?.fields ?? []).filter(isAppConfigField).filter((field) => {
    if (fieldNames.has(field.name)) {
      return false
    }
    fieldNames.add(field.name)
    return true
  })
  const configFields =
    fields.length > 0
      ? fields
          .map((field) => `  ${propertyName(field.name)}${optionalMarker(field)}: ${fieldTsType(field)};`)
          .join('\n')
      : '  [key: string]: any;'

  return `type FrameOSJson = null | boolean | number | string | FrameOSJson[] | { [key: string]: FrameOSJson };

interface FrameOSAppConfig {
${configFields}
}

interface FrameOSImageSpec {
  width?: number;
  height?: number;
  color?: string;
  opacity?: number;
  svg?: string;
  dataUrl?: string;
  base64?: string;
  [key: string]: any;
}

interface FrameOSImageRef {
  __frameosType: "imageRef";
  id: number;
  width: number;
  height: number;
}
/** What frameos.canvas returns: an image ref an img's src takes, that frameos.draw and frameos.clear draw into. */
interface FrameOSCanvasRef extends FrameOSImageRef {
  canvas: string;
  version: number;
  fresh: boolean;
}

interface FrameOSNodeRef {
  __frameosType: "node";
  nodeId: number;
}

interface FrameOSSceneRef {
  __frameosType: "scene";
  sceneId: string;
}

interface FrameOSColorRef {
  __frameosType: "color";
  color: string;
}
interface FrameOSStreamRef { __frameosType: "streamRef"; id?: number; spool?: string; }

/**
 * What JSX makes in an app (.tsx): get() can return it as its image. An <svg>
 * is drawn as it is; any other element is a UI laid out with Tailwind classes
 * (className="flex items-center gap-2 p-4 bg-slate-900 text-white") —
 * docs/jsx-ui.md has what is supported. <img src={...}> takes the image
 * frameos.fetchImage or frameos.loadAssetImage returned.
 */
interface FrameOSElement { type: string; props: Record<string, any>; }
/** What a handler gets: the pointer event, and where in the element it was. */
interface FrameOSUiEvent {
  type: "tap" | "doubleTap" | "longPress" | "swipe" | "pointerDown" | "pointerUp" | "pointerMove" | "change" | "keyDown";
  x: number;
  y: number;
  localX: number;
  localY: number;
  /** The element's size, in scene pixels: localX / width is how far along it the pointer is, at any frame size. Absent before 2026.10.22. */
  width?: number;
  height?: number;
  pointerId?: number;
  pointerType?: "mouse" | "touch" | "pen";
  /** A swipe's way: "left", "right", "up" or "down". */
  direction?: "left" | "right" | "up" | "down";
  /** onChange of an <input> or <textarea>: its text now (also as target.value, as in React). */
  value?: string;
  target?: { value: string };
  /** onKeyDown of a field: the key ("a", "Enter", "Backspace"). */
  key?: string;
  [key: string]: any;
}
interface FrameOSElementProps {
  className?: string;
  children?: any;
  src?: FrameOSImageRef | { image: FrameOSImageRef | null } | null;
  /** A tap on the element; the frame renders again after it. */
  onClick?: (event: FrameOSUiEvent) => void;
  onDoubleClick?: (event: FrameOSUiEvent) => void;
  onLongPress?: (event: FrameOSUiEvent) => void;
  onPointerDown?: (event: FrameOSUiEvent) => void;
  onPointerUp?: (event: FrameOSUiEvent) => void;
  /** The pointer moved: over the element, or anywhere while a press it took is held (captured until the release). */
  onPointerMove?: (event: FrameOSUiEvent) => void;
  /** A swipe that began on the element, with its direction; one in from the screen edge is the frame's. */
  onSwipe?: (event: FrameOSUiEvent) => void;
  /** <input> and <textarea>: the text shown (keep it in a variable, set it in onChange), a hint while empty, and the kind of field. */
  value?: string | number;
  placeholder?: string;
  type?: "text" | "password" | "number";
  /** Every edit of a field, with its text now: e.value, or e.target.value. onInput is the same. Absent before 2026.10.22. */
  onChange?: (event: FrameOSUiEvent) => void;
  onInput?: (event: FrameOSUiEvent) => void;
  /** A key typed into a field (on the screen's keyboard or a real one), before it is applied: e.key. */
  onKeyDown?: (event: FrameOSUiEvent) => void;
  [attribute: string]: any;
}
/**
 * <Scene id="..." /> draws another scene of this frame, at the place and size the UI
 * gives it (flex-1 unless the classes say). Other props are that scene's state. It renders on its
 * own schedule. FrameOS 2026.11.5+.
 */
declare const Scene: string;
/**
 * <yield />: where a layout shows the scene it wraps (docs/scene-layouts.md).
 * FrameOS 2026.11.5+.
 */
declare namespace JSX {
  type Element = FrameOSElement;
  interface ElementChildrenAttribute { children: {}; }
  interface IntrinsicElements { [tag: string]: FrameOSElementProps; }
}
/**
 * memo(Component), as React's: called with props shallow-equal to its last
 * call at the same place (its turn among this render's calls, or its key),
 * the component does not run and the frame takes that element's layout and
 * drawing back as they were. A function made anew each render
 * (onClick={() => ...}) is never equal: pass values, make handlers inside.
 */
declare function memo<P extends Record<string, any>>(component: (props: P) => any): (props: P & { key?: string | number }) => any;

interface FrameOSApp {
  nodeId: number;
  nodeName: string;
  category: string;
  config: FrameOSAppConfig;
  state: Record<string, any>;
  frame: {
    /** The panel's width; for a .tsx or .jsx app, divided by the render scale. */
    width: number;
    /** The panel's height; for a .tsx or .jsx app, divided by the render scale. */
    height: number;
    rotate: number;
    assetsPath: string;
    timeZone: string;
    /** The frame's debug setting (FrameOS 2026.10.13+; undefined before). */
    debug?: boolean;
    /** An ESP32-class runtime, or the preview running as one (FrameOS 2026.10.13+; undefined before). */
    embedded?: boolean;
    /** The render scale that applies to the scene. A .tsx or .jsx app's sizes are the panel's
     * divided by it, and its JSX is drawn that many times larger (FrameOS 2026.10.22+; undefined before). */
    scale?: number;
    /** A panel that shows a change only in a refresh, as e-paper and a monochrome OLED do. An app that follows
     * a finger waits for it to lift there (FrameOS 2026.11.5+; undefined before). */
    paper?: boolean;
    /** Whether the panel shows colors (an LCD, an HDMI screen, a four-, six- or seven-ink e-paper). False on
     * a black-and-white or grey panel, where a scene reads better drawn in high contrast (FrameOS 2026.11.6+;
     * undefined before, so treat undefined as color). */
    color?: boolean;
    /** The name of the scene showing. A layout's app gets the name of the scene it wraps (FrameOS 2026.11.5+;
     * undefined before). */
    sceneName?: string;
    /** True in a layout's app while it wraps a built-in scene (the scene list, the settings). Returning a bare <yield />
     * then gives that scene the whole panel (FrameOS 2026.11.5+; undefined before). */
    systemScene?: boolean;
    /** The battery's charge from 0 to 100, on an ESP32 frame with a battery. Undefined elsewhere, so check
     * before drawing it (FrameOS 2026.11.5+; undefined before). */
    batteryPercent?: number;
    /** The Wi-Fi signal in dBm, about -50 strong and -85 weak, on an ESP32 frame that is connected. Undefined
     * elsewhere, so check before drawing it (FrameOS 2026.11.5+; undefined before). */
    wifiRssi?: number;
  };
  initialized?: boolean;
  log(...args: any[]): void;
  logError(...args: any[]): void;
  [key: string]: any;
}

${eventTypeDeclarations}
interface FrameOSContext {
${appContextMembers}  [key: string]: any;
}

/** The typed arrays frameos.ops takes. */
type FrameOSTypedArray =
  | Uint8Array
  | Uint8ClampedArray
  | Int8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array;
/** An 8-bit palette frame's cells: one byte each, an index into its palette. */
type FrameOSPixelCells = Uint8Array | Uint8ClampedArray;
/** Up to 256 colors as 0xRRGGBB numbers. */
type FrameOSPalette = number[] | Uint32Array;
declare const frameos: {
  image(spec?: FrameOSImageSpec): FrameOSImageSpec & { __frameosType: "image" };
  /** SVG markup that came from elsewhere (a download, an asset) as an image. A drawing the app makes is JSX returned from a .tsx app's get(), never markup built as a string. */
  svg(svg: string, spec?: FrameOSImageSpec): FrameOSImageSpec & { __frameosType: "image"; svg: string };
  node(nodeId: number): FrameOSNodeRef;
  scene(sceneId: string): FrameOSSceneRef;
  color(color: string): FrameOSColorRef;
  log(...args: any[]): void;
  error(...args: any[]): void;
  setNextSleep(seconds: number): void;
  /** Sends an event as a dispatch node does: render, setCurrentScene, setSceneState, sceneSwitcher, sceneSettings or a
   * custom event of the scene's. An event a scene may not send is logged and dropped (FrameOS 2026.11.5+). */
  dispatch(event: string, payload?: Record<string, any>): void;
  fetchText(url: string): string;
  fetchJson(url: string): any;
  httpRequest(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      bodyBase64?: string;
      base64?: boolean;
      timeoutMs?: number;
      find?: string;
      findLength?: number;
      findLimit?: number;
    }
  ): { status: number; body?: string; bodyBase64?: string; found?: string[]; error?: string };
  fetchImage(
    url: string,
    options?: {
      headers?: Record<string, string>;
      saveAsset?: { name: string; extension?: string; mode?: "auto" | "always" };
      exif?: boolean;
      // The image's color profile (a .frameos.json sidecar's colors object); null = none, clears the last palette.
      colors?: { [key: string]: any } | null;
      // Keep the picture for later renders (a JSX gallery's photo, drawn again without a download) until
      // frameos.releaseImage(ref) or the interpreter goes; 8 at most. Never the consumer's target.
      keep?: boolean;
      // With keep: the size to decode it at, in the canvas's pixel format (a host decodes at the picture's own size).
      width?: number;
      height?: number;
      fit?: "cover" | "contain";
    }
  ): {
    image: FrameOSImageRef | null;
    width?: number;
    height?: number;
    error?: string;
    savedAs?: string;
    exif?: Record<string, any>;
    exifSummary?: string;
  };
  /** Lets a picture fetchImage kept ({ keep: true }) go. False for one that was not kept, or is gone. */
  releaseImage(image: FrameOSImageRef | { image: FrameOSImageRef | null } | null): boolean;
  /**
   * The app's canvas called key: a picture it draws into and shows as an img's src. Made and filled with
   * color (white) the first time, or when the size changes; the same picture every render while the interpreter
   * lives (4 at most). Its fresh is true the render it was made: draw your record into it again then.
   */
  canvas(key: string, width: number, height: number, color?: string): FrameOSCanvasRef | null;
  /** Draws SVG (JSX: <line>, <circle>, <path>, <polyline>, <g>, an <svg viewBox>; or markup) into a canvas, over what is there. */
  draw(canvas: FrameOSCanvasRef, content: FrameOSElement | string): boolean;
  /** Fills a canvas with color (white by default). */
  clear(canvas: FrameOSCanvasRef, color?: string): boolean;
  /**
   * The 8-bit palette mode, to return from get() (FrameOS 2026.11.8+): width x height cells, a byte each, rows top to
   * bottom, each an index into palette (up to 256 0xRRGGBB colors; past its end, black) drawn as a pixelSize square.
   * Written straight into the panel's buffer with no canvas and no JSX, rewriting only the cells whose index or color
   * changed since the last frame: animate the cells, or only the palette (color cycling). width and height default to
   * the frame's size over pixelSize.
   */
  pixels(cells: FrameOSPixelCells, palette: FrameOSPalette, options?: { width?: number; height?: number; pixelSize?: number }): unknown;
  /**
   * Whole typed arrays at a time, at native speed (FrameOS 2026.11.8+): a per-cell pass in one call instead of a
   * loop of bytecodes. Each element is read and stored by its array's kind (Uint8Clamped clamps, other integers
   * wrap, Float32 is a float, a number b is a Float32 too); BigInt, Float16 and Float64 arrays are refused (false).
   * start and end are elements. Check for it (if (frameos.ops)) to run on older FrameOS too.
   */
  ops: {
    /** dst[i] = table[src[i]]: a fade, a palette remap. An index past the table leaves dst[i] as it is. */
    map(dst: FrameOSTypedArray, src: FrameOSTypedArray, table: FrameOSTypedArray, start?: number, end?: number): boolean;
    /** dst[i] = a[i] + b[i], or + b when b is a number. */
    add(dst: FrameOSTypedArray, a: FrameOSTypedArray, b: FrameOSTypedArray | number, start?: number, end?: number): boolean;
    sub(dst: FrameOSTypedArray, a: FrameOSTypedArray, b: FrameOSTypedArray | number, start?: number, end?: number): boolean;
    mul(dst: FrameOSTypedArray, a: FrameOSTypedArray, b: FrameOSTypedArray | number, start?: number, end?: number): boolean;
    /**
     * A 3x3 integer kernel (9 weights, row by row) over a grid width wide, shifted right by shift; the edges are left
     * as they are, so a dst whose edges must hold still holds nothing else (write other values to another array).
     * dst can be src only when the centre alone weighs: it reads cells it has written.
     */
    convolve(dst: FrameOSTypedArray, src: FrameOSTypedArray, width: number, kernel: number[], shift?: number): boolean;
  };
  listAssets(dir?: string): string[];
  assetExists(path: string): boolean;
  assetSize(path: string): number;
  readAsset(path: string, options?: { offset?: number; length?: number }): string | null;
  writeAsset(path: string, base64: string): boolean;
  appendAsset(path: string, base64: string): boolean;
  deleteAsset(path: string): boolean;
  loadAssetImage(path: string): FrameOSImageRef | null;
  openAssetStream(path: string, mode?: "r" | "w" | "a"): FrameOSStreamRef | null;
  createStream(base64: string): FrameOSStreamRef | null;
  streamRead(stream: FrameOSStreamRef | number, length: number): string | null;
  streamWrite(stream: FrameOSStreamRef | number, base64: string): boolean;
  streamAtEnd(stream: FrameOSStreamRef | number): boolean;
  streamRewind(stream: FrameOSStreamRef | number): boolean;
  streamClose(stream: FrameOSStreamRef | number): boolean;
  /**
   * Reads text a line at a time without ever holding it whole (FrameOS 2026.11.6+): a string, a stream, or a
   * field whose config.json entry has "capabilities": { "byteIter": {} }, which gets a downloaded body as a stream
   * however large it is. Lines not starting with one of \`only\` are read past natively and cost nothing. Closed when
   * the call that opened it returns.
   */
  openLines(
    source: FrameOSStreamRef | string,
    options?: {
      /** A line starting with a space or tab continues the one before (iCal, vCard, mail headers). */
      unfold?: boolean;
      /** Strip whitespace off both ends. */
      trim?: boolean;
      /** Keep only the lines starting with one of these. */
      only?: string[];
      /** Bytes; a longer line is cut. 65536 by default. */
      maxLength?: number;
    }
  ): FrameOSStreamRef | null;
  /** The next line of an openLines reader, or null at the end. */
  nextLine(stream: FrameOSStreamRef | number): string | null;
  /** The lines up to the next one starting with stop (which only must keep), joined with newlines, stop left out;
   * null when the text ends first. One call for a whole record, the cheap way through a long feed. */
  nextBlock(stream: FrameOSStreamRef | number, stop: string): string | null;
  /** A time zone's canonical name and its UTC offsets: changes is [start, offset, start, offset, ...] in seconds,
   * empty on a frame without that zone's data (FrameOS 2026.11.6+). */
  timeZone(name: string): { name: string; changes: number[] };
  getSetting(...path: string[]): any;
  setState(key: string, value: FrameOSJson): void;
  /** Keep a value for this node between renders (FrameOS 2026.10.13+). null forgets it. */
  remember(key: string, value: FrameOSJson): boolean;
  recall(key: string): FrameOSJson | undefined;
};

/** console.log and friends log like frameos.log; warn says so; error goes to the error log (FrameOS 2026.10.16+). */
declare const console: {
  log(...args: any[]): void;
  info(...args: any[]): void;
  debug(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
};
`
}

/**
 * What a test file (`<name>.test.ts` next to app.ts) can use, on top of the
 * app's own API: the harness the runtime evaluates before the test module
 * (frameos/src/frameos/js_runtime/app_test_harness.js, docs/js-apps-and-code-nodes.md
 * "Testing an app"). Added to the editor as a second declaration file.
 */
export const appTestTypeDeclarations = `
interface FrameOSMockFn<T extends (...args: any[]) => any = (...args: any[]) => any> {
  (...args: Parameters<T>): ReturnType<T>;
  /** Every call's arguments, in order. */
  calls: Parameters<T>[];
  results: ReturnType<T>[];
  mockImplementation(impl: T): FrameOSMockFn<T>;
  mockReturnValue(value: ReturnType<T>): FrameOSMockFn<T>;
  mockReset(): FrameOSMockFn<T>;
}

interface FrameOSTestApp extends FrameOSApp {
  /** What frameos.getSetting reads in a test. */
  settings: Record<string, any>;
  /** What frameos.remember / recall keep in a test. */
  memory: Map<string, string>;
  /** What frameos.setNextSleep set, or null. */
  nextSleep: number | null;
}

interface FrameOSExpect<T> {
  toBe(expected: T): void;
  toEqual(expected: any): void;
  toStrictEqual(expected: any): void;
  toMatchObject(expected: Record<string, any> | any[]): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeNaN(): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toBeCloseTo(n: number, digits?: number): void;
  toHaveLength(n: number): void;
  toContain(item: any): void;
  toContainEqual(item: any): void;
  toHaveProperty(path: string, value?: any): void;
  toMatch(pattern: string | RegExp): void;
  toBeInstanceOf(cls: any): void;
  /** For a function: it throws, and the message contains the text / matches the pattern. */
  toThrow(expected?: string | RegExp | (new (...args: any[]) => any)): void;
  toHaveBeenCalled(): void;
  toHaveBeenCalledTimes(n: number): void;
  toHaveBeenCalledWith(...args: any[]): void;
  toHaveBeenLastCalledWith(...args: any[]): void;
}

declare function describe(name: string, fn: () => void): void;
declare namespace describe {
  function skip(name: string, fn: () => void): void;
  function only(name: string, fn: () => void): void;
}
declare function it(name: string, fn: () => void): void;
declare namespace it {
  function skip(name: string, fn: () => void): void;
  function only(name: string, fn: () => void): void;
  function todo(name: string): void;
}
declare const test: typeof it;
declare function beforeEach(fn: () => void): void;
declare function afterEach(fn: () => void): void;
declare function beforeAll(fn: () => void): void;
declare function afterAll(fn: () => void): void;
declare function expect<T>(received: T): FrameOSExpect<T> & { not: FrameOSExpect<T> };

/**
 * An app object like the runtime hands get(): config.json's field defaults
 * under the given config, state, frame (800x480, UTC) and settings. It is
 * the app frameos.setState, remember, recall, getSetting and setNextSleep
 * act on until the next makeApp (or useApp).
 */
declare function makeApp(options?: {
  config?: Record<string, any>;
  state?: Record<string, any>;
  frame?: Partial<FrameOSApp["frame"]>;
  settings?: Record<string, any>;
  nodeId?: number;
  nodeName?: string;
}): FrameOSTestApp;
declare function useApp(app: FrameOSTestApp): FrameOSTestApp;
/** A render context: { event: "render", payload: {} } under what is given. */
declare function makeContext(context?: Partial<FrameOSContext>): FrameOSContext;

/**
 * Everything that leaves the interpreter throws until the test mocks it, so a
 * test never touches the network: mock.httpRequest(...), mock.fetchImage(...)
 * and so on replace that frameos function for the test and return the mock
 * function (its .calls say what the app asked for). fetchText and fetchJson
 * go through the mocked httpRequest by default. Restored after each test.
 */
declare const mock: {
  fn<T extends (...args: any[]) => any>(impl?: T): FrameOSMockFn<T>;
  frameos<K extends keyof typeof frameos>(name: K, impl?: (typeof frameos)[K]): FrameOSMockFn<(typeof frameos)[K]>;
  /** Back to the test defaults. */
  restore(): void;
  /** A { status, body } reply for mock.httpRequest; an object body is sent as JSON. */
  response(status: number, body?: string | Record<string, any> | any[], extra?: Record<string, any>): { status: number; body: string } & Record<string, any>;
  json(body: any, status?: number): { status: number; body: string };
  /** A frameos.fetchImage reply with an image reference the app can return. */
  image(spec?: { width?: number; height?: number; [key: string]: any }): { image: FrameOSImageRef; width: number; height: number; [key: string]: any };
  httpRequest(impl?: (typeof frameos)["httpRequest"]): FrameOSMockFn<(typeof frameos)["httpRequest"]>;
  fetchText(impl?: (typeof frameos)["fetchText"]): FrameOSMockFn<(typeof frameos)["fetchText"]>;
  fetchJson(impl?: (typeof frameos)["fetchJson"]): FrameOSMockFn<(typeof frameos)["fetchJson"]>;
  fetchImage(impl?: (typeof frameos)["fetchImage"]): FrameOSMockFn<(typeof frameos)["fetchImage"]>;
  getSetting(impl?: (typeof frameos)["getSetting"]): FrameOSMockFn<(typeof frameos)["getSetting"]>;
  setState(impl?: (typeof frameos)["setState"]): FrameOSMockFn<(typeof frameos)["setState"]>;
  remember(impl?: (typeof frameos)["remember"]): FrameOSMockFn<(typeof frameos)["remember"]>;
  recall(impl?: (typeof frameos)["recall"]): FrameOSMockFn<(typeof frameos)["recall"]>;
  setNextSleep(impl?: (typeof frameos)["setNextSleep"]): FrameOSMockFn<(typeof frameos)["setNextSleep"]>;
  dispatch(impl?: (typeof frameos)["dispatch"]): FrameOSMockFn<(typeof frameos)["dispatch"]>;
  listAssets(impl?: (typeof frameos)["listAssets"]): FrameOSMockFn<(typeof frameos)["listAssets"]>;
  assetExists(impl?: (typeof frameos)["assetExists"]): FrameOSMockFn<(typeof frameos)["assetExists"]>;
  assetSize(impl?: (typeof frameos)["assetSize"]): FrameOSMockFn<(typeof frameos)["assetSize"]>;
  readAsset(impl?: (typeof frameos)["readAsset"]): FrameOSMockFn<(typeof frameos)["readAsset"]>;
  writeAsset(impl?: (typeof frameos)["writeAsset"]): FrameOSMockFn<(typeof frameos)["writeAsset"]>;
  appendAsset(impl?: (typeof frameos)["appendAsset"]): FrameOSMockFn<(typeof frameos)["appendAsset"]>;
  deleteAsset(impl?: (typeof frameos)["deleteAsset"]): FrameOSMockFn<(typeof frameos)["deleteAsset"]>;
  loadAssetImage(impl?: (typeof frameos)["loadAssetImage"]): FrameOSMockFn<(typeof frameos)["loadAssetImage"]>;
  openAssetStream(impl?: (typeof frameos)["openAssetStream"]): FrameOSMockFn<(typeof frameos)["openAssetStream"]>;
  createStream(impl?: (typeof frameos)["createStream"]): FrameOSMockFn<(typeof frameos)["createStream"]>;
  streamRead(impl?: (typeof frameos)["streamRead"]): FrameOSMockFn<(typeof frameos)["streamRead"]>;
  streamWrite(impl?: (typeof frameos)["streamWrite"]): FrameOSMockFn<(typeof frameos)["streamWrite"]>;
  streamAtEnd(impl?: (typeof frameos)["streamAtEnd"]): FrameOSMockFn<(typeof frameos)["streamAtEnd"]>;
  streamRewind(impl?: (typeof frameos)["streamRewind"]): FrameOSMockFn<(typeof frameos)["streamRewind"]>;
  streamClose(impl?: (typeof frameos)["streamClose"]): FrameOSMockFn<(typeof frameos)["streamClose"]>;
  openLines(impl?: (typeof frameos)["openLines"]): FrameOSMockFn<(typeof frameos)["openLines"]>;
  nextLine(impl?: (typeof frameos)["nextLine"]): FrameOSMockFn<(typeof frameos)["nextLine"]>;
  nextBlock(impl?: (typeof frameos)["nextBlock"]): FrameOSMockFn<(typeof frameos)["nextBlock"]>;
  timeZone(impl?: (typeof frameos)["timeZone"]): FrameOSMockFn<(typeof frameos)["timeZone"]>;
  log(impl?: (typeof frameos)["log"]): FrameOSMockFn<(typeof frameos)["log"]>;
  error(impl?: (typeof frameos)["error"]): FrameOSMockFn<(typeof frameos)["error"]>;
};
`
