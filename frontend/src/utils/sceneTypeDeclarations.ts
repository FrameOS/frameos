import type { StateField } from '../types'
import { eventTypeDeclarations } from './eventsContract.gen'
import { selectFieldValues } from './selectOptions'

// The ambient types a pure JS scene (docs/pure-js-scenes.md) is edited
// against: `import type { Scene, Canvas } from "frameos"`. The frame erases
// the import; Monaco resolves it here. Keep in step with
// frameos/src/frameos/js_scene.nim (the scene prelude) and
// frameos/src/frameos/js_runtime/canvas_api.nim (the methods).

const fieldTypeToTsType: Record<string, string> = {
  string: 'string',
  text: 'string',
  float: 'number',
  integer: 'number',
  boolean: 'boolean',
  color: 'string',
  date: 'string',
  json: 'any',
  select: 'string',
  font: 'string',
  path: 'string',
  image: 'any',
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
}

function fieldTsType(field: StateField): string {
  if (field.type === 'select') {
    const values = selectFieldValues(field.options)
    if (values.length > 0) {
      return values.map((value) => JSON.stringify(value)).join(' | ')
    }
  }
  return fieldTypeToTsType[field.type] ?? 'any'
}

/** The `Scene` / `Canvas` declarations, with `scene.state` typed from the scene's own fields. */
export function buildSceneTypeDeclarations(fields: StateField[] | undefined): string {
  const seen = new Set<string>()
  const stateFields = (fields ?? [])
    .filter((field) => field?.name && !seen.has(field.name) && seen.add(field.name))
    .map((field) => `    ${propertyName(field.name)}: ${fieldTsType(field)};`)
    .join('\n')
  return `declare module "frameos" {
  type FrameOSJson = null | boolean | number | string | FrameOSJson[] | { [key: string]: FrameOSJson };

  /** "#rgb", "#rrggbb", "#rrggbbaa", a CSS color name, or 0xRRGGBB (opaque). */
  export type Color = string | number;
  export type BlendMode = "normal" | "overwrite" | "multiply" | "screen" | "darken" | "lighten" | "mask";
  export type Fit = "cover" | "contain" | "stretch" | "center";
  /** [x0, y0, x1, y1, …] — a plain array or any typed array, read in place. */
  export type Points = ArrayLike<number>;

  export interface TextOptions {
    /** A font file in the frame's fonts folder; the default face when omitted. */
    font?: string;
    size?: number;
    color?: Color;
    /** Wrap and align inside this width (0 = no wrapping). */
    width?: number;
    /** With \`fit\`, the height the text must fit into; also used by \`valign\`. */
    height?: number;
    align?: "left" | "center" | "right";
    valign?: "top" | "middle" | "bottom";
    wrap?: boolean;
    /** Shrink the size until the text fits width × height. */
    fit?: boolean;
    lineHeight?: number;
    underline?: boolean;
    strikethrough?: boolean;
  }

  export interface TextMetrics { width: number; height: number; }

  export interface PathOptions {
    x?: number; y?: number; scale?: number;
    /** Degrees. */
    rotate?: number;
    evenOdd?: boolean;
    blend?: BlendMode;
  }

  export interface StrokeOptions extends PathOptions {
    cap?: "butt" | "round" | "square";
    join?: "miter" | "round" | "bevel";
    /** Dash lengths: [on, off, …]. */
    dash?: number[];
  }

  /**
   * A rectangle of pixels: the frame's render surface, a \`cell\` of it, or an
   * offscreen image from \`scene.newImage\`. Every call draws straight into
   * it; nothing the size of the canvas is allocated.
   */
  export interface Canvas {
    readonly width: number;
    readonly height: number;
    /** "rgbx", or "rgb565" on the largest ESP32 panels. */
    readonly format: "rgbx" | "rgb565";
    clear(color: Color): void;
    fillRect(x: number, y: number, width: number, height: number, color: Color): void;
    strokeRect(x: number, y: number, width: number, height: number, color: Color, lineWidth?: number): void;
    fillRoundedRect(x: number, y: number, width: number, height: number, radius: number, color: Color): void;
    fillCircle(cx: number, cy: number, radius: number, color: Color): void;
    strokeCircle(cx: number, cy: number, radius: number, color: Color, lineWidth?: number): void;
    fillEllipse(cx: number, cy: number, rx: number, ry: number, color: Color): void;
    line(x1: number, y1: number, x2: number, y2: number, color: Color, lineWidth?: number, options?: { cap?: "butt" | "round" | "square" }): void;
    /** An SVG path string ("M0 0 L10 10 Z"), placed with \`x\`/\`y\` and \`scale\`. */
    fillPath(d: string, color: Color, options?: PathOptions): void;
    strokePath(d: string, color: Color, lineWidth?: number, options?: StrokeOptions): void;
    polyline(points: Points, color: Color, lineWidth?: number, options?: { close?: boolean; cap?: "butt" | "round" | "square"; join?: "miter" | "round" | "bevel" }): void;
    fillPolygon(points: Points, color: Color): void;
    /** Draws text at x, y (its top-left) and returns the laid-out size. */
    text(text: string, x: number, y: number, options?: TextOptions): TextMetrics;
    measureText(text: string, options?: TextOptions): TextMetrics;
    /**
     * A picture from an http(s):// URL, a data: URL, a path under the frame's
     * assets folder, or another canvas — decoded straight into the rectangle.
     * False (and a log line) when it could not be loaded.
     */
    image(source: string | Canvas, options?: { x?: number; y?: number; width?: number; height?: number; fit?: Fit; blend?: BlendMode }): boolean;
    /** Rasterises an SVG into the rectangle. False when the SVG is not supported. */
    svg(svg: string, options?: { x?: number; y?: number; width?: number; height?: number }): boolean;
    /** A linear gradient; \`angle\` as in CSS (180 = top to bottom, 90 = left to right). */
    gradient(x: number, y: number, width: number, height: number, options?: { from?: Color; to?: Color; colors?: Color[]; angle?: number }): void;
    /** A window onto the same pixels: draws are clipped to it and land in the parent. Zero copy. */
    cell(x: number, y: number, width: number, height: number): Canvas;
    /** Composites another canvas (an offscreen image) here. */
    draw(source: Canvas, x: number, y: number, options?: { blend?: BlendMode; width?: number; height?: number }): void;
    setPixel(x: number, y: number, color: Color): void;
    /** 0xRRGGBB */
    getPixel(x: number, y: number): number;
    /** The canvas memory itself — premultiplied RGBA bytes, or packed 5/6/5 — zero copy, valid for this render only. */
    pixels(): Uint8Array | Uint16Array;
    /** Release an offscreen image now (collection frees it too). */
    free(): void;
    isValid(): boolean;
  }

  export interface SceneState {
${stateFields}
    /** Seconds between renders; a public state field on every scene. */
    refreshInterval: number;
    [key: string]: any;
  }

  export interface Scene {
    /** The scene's state: read fields, assign to write them. */
    readonly state: SceneState;
    readonly frame: { width: number; height: number; rotate: number; timeZone: string; assetsPath: string };
    readonly id: string;
    readonly name: string;
    readonly timeZone: string;
    readonly backgroundColor: string;
    readonly refreshInterval: number;
    /** The event the current run is for ("render", "init", a button, …) and its payload. */
    readonly event: string;
    readonly payload: any;
    /** Seconds since the epoch. */
    now(): number;
    /** Curly-token formatting in the frame's time zone: "{hour/2}:{minute/2}", "{weekday}, {day} {month/n}". */
    format(timestamp: number, pattern: string): string;
    parseTs(pattern: string, text: string): number;
    /** Send an event through the dispatcher: "setSceneState", "setCurrentScene", a custom event. */
    dispatch(event: string, payload?: FrameOSJson): void;
    /** An offscreen RGBA canvas the scene owns. Refused when the frame cannot afford it. */
    newImage(width: number, height: number): Canvas;
    /** Decode a picture into a new offscreen canvas of that size; null when it fails. */
    loadImage(source: string, options?: { width: number; height: number; fit?: Fit }): Canvas | null;
    setState(key: string, value: FrameOSJson): void;
    /** Sleep this long after this render instead of the interval, once. */
    setNextSleep(seconds: number): void;
    log(...args: any[]): void;
    error(...args: any[]): void;
    fetchText(url: string): string;
    fetchJson(url: string): any;
    httpRequest(url: string, options?: { method?: string; headers?: Record<string, string>; body?: string; bodyBase64?: string; base64?: boolean; timeoutMs?: number }): { status: number; body?: string; bodyBase64?: string; error?: string };
    listAssets(dir?: string): string[];
    assetExists(path: string): boolean;
    assetSize(path: string): number;
    readAsset(path: string, options?: { offset?: number; length?: number }): string | null;
    writeAsset(path: string, base64: string): boolean;
    appendAsset(path: string, base64: string): boolean;
    deleteAsset(path: string): boolean;
    /** Only the settings namespaces the scene's config.json lists under "settings". */
    getSetting(...path: string[]): any;
  }
}

${eventTypeDeclarations}
declare const scene: import("frameos").Scene;
declare const console: { log(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void };
`
}
