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
interface FrameOSStreamRef { __frameosType: "streamRef"; id: number; }

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
  type: "tap" | "doubleTap" | "longPress" | "swipe" | "pointerDown" | "pointerUp" | "pointerMove";
  x: number;
  y: number;
  localX: number;
  localY: number;
  pointerId?: number;
  pointerType?: "mouse" | "touch" | "pen";
  /** A swipe's way: "left", "right", "up" or "down". */
  direction?: "left" | "right" | "up" | "down";
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
  [attribute: string]: any;
}
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
    width: number;
    height: number;
    rotate: number;
    assetsPath: string;
    timeZone: string;
    /** The frame's debug setting (FrameOS 2026.10.13+; undefined before). */
    debug?: boolean;
    /** An ESP32-class runtime, or the preview running as one (FrameOS 2026.10.13+; undefined before). */
    embedded?: boolean;
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

declare const frameos: {
  image(spec?: FrameOSImageSpec): FrameOSImageSpec & { __frameosType: "image" };
  svg(svg: string, spec?: FrameOSImageSpec): FrameOSImageSpec & { __frameosType: "image"; svg: string };
  node(nodeId: number): FrameOSNodeRef;
  scene(sceneId: string): FrameOSSceneRef;
  color(color: string): FrameOSColorRef;
  log(...args: any[]): void;
  error(...args: any[]): void;
  setNextSleep(seconds: number): void;
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
  log(impl?: (typeof frameos)["log"]): FrameOSMockFn<(typeof frameos)["log"]>;
  error(impl?: (typeof frameos)["error"]): FrameOSMockFn<(typeof frameos)["error"]>;
};
`
