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

/** One scene of the store, as the listing for frames serves it (/api/store/device/scenes). */
interface FrameOSStoreScene {
  id: string;
  name: string;
  category: string | null;
  /** The store's newest version. */
  version: number;
  by: string;
  /** The description, cut to a line or two. */
  about: string;
  /** The cover as a path on the store's host ("/api/store/scenes/<id>/image?version=N"): prefix the store's url. Null without one. */
  image: string | null;
}
/** What frameos.code("read") says: the code editor's host (docs/code-editor.md). */
interface FrameOSCodeFacts {
  /** The action running ("ask", "save"), else "". One at a time. */
  busy: string;
  /** The last action's refusal ("no_plane", "needs_owner", "ai_unavailable", "panel_locked", ...), else "". */
  error: string;
  /** The last action that worked ("ask", "save"), else "". */
  done: string;
  /** The AI's last scene, read whole with frameos.code("draft"); null without one. */
  draft: { id: string; name: string; summary: string } | null;
  /** An AI can be asked: the frame has a control plane. */
  ask: boolean;
  /** A scene can be saved here. */
  save: boolean;
  /** The browser preview's host: it reads scenes and saves or asks nothing. */
  previewOnly?: boolean;
}
/** What frameos.store() says: the scene store as this frame's host knows it (docs/scene-store.md). */
interface FrameOSStore {
  /** The store this frame browses: its cloud provider, else FrameOS Cloud. The app fetches its listing for frames
   * from it (/api/store/device/scenes?version=...): a page of FrameOSStoreScene at a time. */
  url: string;
  /** This frame's FrameOS: the listing offers only what runs on it. */
  version: string;
  /** The action running ("install", "preview", "update", "remove", "discard"), else "". One at a time. */
  busy: string;
  /** The last action's refusal ("offline", "too_many_scenes", "panel_locked", ...), else "". */
  error: string;
  /** The last action that worked, else "": "uptodate" for an update with nothing newer. */
  done: string;
  /** Every scene on the frame that came from the store: its id here, its store scene and the version it is. */
  installed: { id: string; store: string; v: number }[];
  /** The store scene this frame previews, until it is installed or discarded. */
  preview: { store: string; id: string; name: string } | null;
  /** A scene not from the store may be removed too (a frame with no control plane). */
  removeAny: boolean;
  /** The browser preview's host: Preview, Show and Discard only, and "preview_only" for install, update and remove. Absent on a frame. */
  previewOnly?: boolean;
}
/** What frameos.frame("read") says: the facts the frame page shows (docs/scene-settings.md "The frame page"). */
interface FrameOSFrameFacts {
  /** Absent where there is no network to set from the frame (the browser preview). */
  wifi?: {
    /** "connected", "connecting", "notFound", "auth", "hotspot", "unset" or "off". */
    state: string;
    ssid: string;
    ip?: string;
    /** The signal in dBm, while connected. */
    rssi?: number;
    /** The setup hotspot's name, while it is up. */
    hotspot?: string;
    /** The networks in range by name, from the last scan. */
    networks: string[];
    scanning: boolean;
    /** A password is saved. */
    password: boolean;
  };
  rotate: number;
  renderScale: number;
  battery?: { percent: number };
  /** The control plane that manages the frame, when one does. */
  managedBy?: string;
  version?: string;
  /** The device commands this host runs besides render and reboot ("restart" on a Raspberry Pi). */
  actions: string[];
  /** What the last apply could not do. */
  note?: string;
}

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
  type: "tap" | "doubleTap" | "longPress" | "swipe" | "pinch" | "pointerDown" | "pointerUp" | "pointerMove" | "change" | "keyDown";
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
  /** A swipe's start; a pinch's point between its fingers when the second went down (x, y: when the first lifted). */
  startX?: number;
  startY?: number;
  /** A pinch's spread: how far apart the fingers ended over how far apart they began (below 1 drawn together). Absent before 2026.11.10. */
  scale?: number;
  /** onChange of an <input> or <textarea>: its text now (also as target.value, as in React). */
  value?: string;
  target?: { value: string };
  /** onKeyDown of a field: the key ("a", "Enter", "Backspace"). */
  key?: string;
  [key: string]: any;
}
interface FrameOSElementProps {
  className?: string;
  /**
   * The desktop's look for a role of its theme: "page", "bar", "button", "primary", "selected", "field", "option",
   * "picked", "switch", "switchOn", "knob", "knobOn", "muted", "accent", "card", "tile", "tileLit", "keyboard", "key",
   * "keyMod", "keyLit" (docs/jsx-ui.md "Themes"). Where a layout around the scene gives a theme (a desktop and its
   * windows), the role's colors, borders and corners take the place of the element's own; with none, or a role the
   * theme leaves out, it keeps its classes. An element without it always keeps its own; role is not used for this
   * (FrameOS 2026.11.10+; ignored before).
   */
  look?: string;
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
  /** Two fingers that began on the element moved, as one event when the first lifts: e.scale, e.startX/startY, e.x/y. Neither finger is a tap or a swipe then. Absent before 2026.11.10. */
  onPinch?: (event: FrameOSUiEvent) => void;
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
    /** The places the asset calls reach, each with the name to show it by. The assets folder ("assets", the
     * default) and, on an ESP32 with a TF card in, its internal storage ("internal") beside it. Pass an id as
     * the storage option of the asset calls that read, and of makeAssetFolder and deleteAsset (FrameOS 2026.11.11+;
     * undefined before; writeAsset, appendAsset and streams reach the assets folder alone). */
    storages?: { id: "assets" | "internal"; name: string }[];
    timeZone: string;
    /** The frame's debug setting (FrameOS 2026.10.13+; undefined before). */
    debug?: boolean;
    /** An ESP32-class runtime, or the preview running as one (FrameOS 2026.10.13+; undefined before). */
    embedded?: boolean;
    /** The render scale that applies to the scene. A .tsx or .jsx app's sizes are the panel's
     * divided by it, and its JSX is drawn that many times larger (FrameOS 2026.10.22+; undefined before). */
    scale?: number;
    /** Whether a change shows as soon as it is drawn (an LCD, an HDMI screen). False where each change costs a
     * refresh, as on e-paper today. Follow a finger, animate and show presses only where it is true, and wait
     * for a finger to lift where it is false (FrameOS 2026.11.10+; undefined before, where paper is its
     * opposite, so read app.frame.fast ?? !app.frame.paper). The same in get(), init(), onEvent, a handler
     * and after an await. */
    fast?: boolean;
    /** Whether the panel draws in inks, as e-paper (and a monochrome OLED) does, with few colors, greys
     * dithered and nothing faint, so draw solid colors there. It says how the panel looks. Whether a change
     * costs a refresh is fast, which a fast e-paper would say true with paper true (FrameOS 2026.11.5+;
     * undefined before; until 2026.11.10 it stood for both, and an ESP32 said true on an LCD outside get()). */
    paper?: boolean;
    /** Whether the panel shows colors (an LCD, an HDMI screen, a four-, six- or seven-ink e-paper). False on
     * a black-and-white or grey panel, where a scene reads better drawn in high contrast (FrameOS 2026.11.6+;
     * undefined before, so treat undefined as color). The same in every phase, as fast. */
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
    /** The id of the scene showing; a layout's app gets the id of the scene it wraps, the one its <yield />
     * shows (FrameOS 2026.11.8+; undefined before). */
    sceneId?: string;
    /** The frame's scenes, { id, name } in its scene list's order, layouts left out, on a frame that runs
     * scenes side by side (a Raspberry Pi, an ESP32). There a layout's <Scene id> is that scene itself,
     * running in its window while another has the focus, so a layout can be a desktop of windows. Undefined
     * where one scene runs at a time (the preview of one scene) (FrameOS 2026.11.8+; undefined before).
     * windowSize is a scene's own size for a new window, "WxH" (its settings.windowSize), where it says
     * one (FrameOS 2026.11.10+). icon is the scene's icon, where it has one (its settings.icon): one SVG
     * path in a 0 0 24 24 box, drawn as <svg viewBox="0 0 24 24"><path d={icon} fill="currentColor" /></svg>
     * (FrameOS 2026.11.10+). category is the scene's category by its name ("Photos", "Real time"; its
     * settings.category), where it has one, to group a list of scenes by, those without one last as Other
     * (FrameOS 2026.11.10+). */
    scenes?: { id: string; name: string; windowSize?: string; icon?: string; category?: string }[];
    /** How many of those scenes may run at once, the one in front included, where that is limited (2 on an
     * ESP32 with 8 MB of PSRAM, 1 beside a 13.3-inch colour panel's canvas, 4 with more). A desktop opening
     * one more closes the one that had the focus longest ago. Undefined where there is no limit (a Raspberry
     * Pi) (FrameOS 2026.11.8+; undefined before). */
    windows?: number;
    /** The theme of the desktop around the scene, its roles' classes (a string, or a list of boxes one inside the
     * other), for what look cannot color, as an SVG's fill in the accent's color. Undefined with no desktop or one in
     * its own look (FrameOS 2026.11.10+; undefined before). */
    theme?: Record<string, string | string[]>;
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
  /** The scene store as this frame knows it (docs/scene-store.md): null where there is no store (the browser
   * preview, a frame rendered on its control plane, one whose owner turned the settings on its screen off) and
   * before FrameOS 2026.11.8. Read it every render: what an action did shows up here. */
  store(): FrameOSStore | null;
  /** Asks the frame's host: preview {store, name}, install {store, name, show?: false to stay on this scene}, update
   * {store}, remove {store}, discard. It runs off the render and this scene renders again when it is done (see
   * store().busy). False where there is no host (FrameOS 2026.11.8+). */
  storeAction(action: "preview" | "install" | "update" | "remove" | "discard", args?: Record<string, any>): boolean;
  /** The frame page's facts and powers (docs/terminal.md), for an app whose config.json permissions include "frame"
   * (saving the scene adds it when the code calls this; installing the scene is the owner's yes), and only while the
   * frame's settings are allowed on its screen: it throws otherwise. "read" is what the page shows, null where there is
   * none (FrameOS 2026.11.8+). */
  frame(op: "read"): FrameOSFrameFacts | null;
  /** What the page's Save sets: a network (wifiSsid, with wifiPassword or "" for an open one or the saved one), rotate
   * (0, 90, 180, 270), renderScale (0 automatic, up to 4), and on an ESP32 the clock ("YYYY-MM-DD HH:MM"). A refusal
   * shows as note in the next "read". */
  frame(
    op: "apply",
    changes: { wifiSsid?: string; wifiPassword?: string; rotate?: number; renderScale?: number; clock?: string }
  ): boolean;
  /** What the page's buttons do: render (every panel drawn again), restart (FrameOS, where actions has it), reboot,
   * scan for the networks in range (in "read" once wifi.scanning is false), and on an ESP32 checkUpdate and
   * installUpdate. */
  frame(op: "action", action: "render" | "restart" | "reboot" | "scan" | "checkUpdate" | "installUpdate"): boolean;
  /** The frame's scenes as it holds them and its control plane's scene AI (docs/code-editor.md), for an app whose
   * config.json permissions include "code" (saving the scene adds it when the code calls this), and only while the
   * frame's settings are allowed on its screen: it throws otherwise. "read" is the host's facts, null without a host
   * (FrameOS 2026.11.11+). */
  code(op: "read"): FrameOSCodeFacts | null;
  /** A scene as the frame holds it (its scenes.json object), or null. */
  code(op: "source", sceneId: string): Record<string, any> | null;
  /** The AI's last scene, or null. */
  code(op: "draft"): Record<string, any> | null;
  /** Asks the plane's AI for a scene: a change to the scene given, else a new one. It runs off the render and this scene
   * renders again when it is done (read().busy, then read().draft). Nothing is saved. */
  code(op: "ask", args: { prompt: string; scene?: Record<string, any> }): boolean;
  /** Puts the scene on the frame (replacing one of its id), shown unless show is false. A save from the frame may not
   * ask for permissions or settings the saved scene did not have (error "needs_owner"). */
  code(op: "save", args: { scene: Record<string, any>; show?: boolean }): boolean;
  /** Forgets the draft and the last error. */
  code(op: "clear"): boolean;
  /** How tall each text is, in pixels, set in className's text classes (font-*, text-*, leading-*) into width, as a
   * <textarea> sets its text: wrapped at spaces, spaces kept, an empty text one line. For a list whose rows are text
   * that wraps (a code editor's lines), measured before they are laid out (FrameOS 2026.11.12+). */
  measureText(texts: string[], options: { className?: string; width: number }): number[];
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
      /** Writes a JSON reply's first string field of this name, base64, decoded into an asset (the app's "assets-write"
       * rules) and leaves that field empty in body: a picture an API returns inline (OpenAI's image generation
       * result) never becomes a JS string, which on an ESP32 it would not fit as. The reply says saved, or
       * saveError; a runtime before FrameOS 2026.11.12 ignores the option and returns the body whole. */
      saveBase64Field?: { field: string; path: string };
      /** Puts an asset's bytes, base64, into the body where marker is (a picture uploaded from its file, the same
       * way). With no such asset or marker the request is not sent (FrameOS 2026.11.12+; ignored before). */
      bodyAsset?: { marker: string; path: string };
    }
  ): {
    status: number;
    body?: string;
    bodyBase64?: string;
    found?: string[];
    error?: string;
    saved?: { path: string; bytes: number };
    saveError?: string;
  };
  fetchImage(
    url: string,
    options?: {
      headers?: Record<string, string>;
      saveAsset?: { name: string; extension?: string; mode?: "auto" | "always" };
      exif?: boolean;
      // The image's color profile (a .frameos.json sidecar's colors object); null = none, clears the last palette.
      colors?: { [key: string]: any } | null;
      // Keep the picture for later renders (a JSX gallery's photo, drawn again without a download) until
      // frameos.releaseImage(ref) or the interpreter goes; 8 at most, or up to 48 small ones (a grid of
      // thumbnails, no more pixels than eight 480x480 photos). Never the consumer's target.
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
  /** Every file below dir, as paths in the assets folder; with shallow, the folder's own entries, a folder's
   * ending in "/" (FrameOS 2026.11.8+). */
  listAssets(dir?: string, options?: { shallow?: boolean; storage?: "assets" | "internal" }): string[];
  assetExists(path: string, options?: { storage?: "assets" | "internal" }): boolean;
  assetSize(path: string, options?: { storage?: "assets" | "internal" }): number;
  /** The file's bytes as base64, or with text as a string (UTF-8, without the halves of characters a slice cuts at its
   * ends). entry reads that member of a ZIP file instead (an EPUB's chapter, inflated by the frame a window at a
   * time): offset and length are then the member's, and a file that is not a ZIP, or has no such member, is null.
   * A slice over the frame's limit (2 MB on an ESP32) is null: read it in parts with offset and length
   * (entry and text: FrameOS 2026.11.11+). */
  readAsset(
    path: string,
    options?: { offset?: number; length?: number; text?: boolean; entry?: string; storage?: "assets" | "internal" }
  ): string | null;
  writeAsset(path: string, base64: string): boolean;
  appendAsset(path: string, base64: string): boolean;
  deleteAsset(path: string, options?: { storage?: "assets" | "internal" }): boolean;
  /** One folder, inside a folder that is there: true when it was made, false when it was there already or refused
   * (a name starting with a dot, one the listing hides, an app without "assets-write") (FrameOS 2026.11.10+). */
  makeAssetFolder(path: string, options?: { storage?: "assets" | "internal" }): boolean;
  /** An image file of the assets folder. With width and height it is decoded at that size (a JPEG scaled as it
   * decodes) and keep holds it for later renders, as fetchImage's options do (FrameOS 2026.11.8+). With neither,
   * the picture an app returns is decoded straight into the canvas it is drawn on where the runtime offers one,
   * as fetchImage's is: a full-screen photo never costs a second canvas (FrameOS 2026.11.12+). */
  loadAssetImage(
    path: string,
    options?: {
      keep?: boolean;
      width?: number;
      height?: number;
      fit?: "cover" | "contain";
      /** A picture inside a ZIP file (an EPUB's illustration or cover), as readAsset's entry (FrameOS 2026.11.11+). */
      entry?: string;
      /** With entry and a size: the colour under the picture's transparent parts (FrameOS 2026.11.11+). */
      background?: string;
      /** Which of app.frame.storages the path is in (FrameOS 2026.11.11+). */
      storage?: "assets" | "internal";
    }
  ): FrameOSImageRef | null;
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
  frame(impl?: (typeof frameos)["frame"]): FrameOSMockFn<(typeof frameos)["frame"]>;
  code(impl?: (typeof frameos)["code"]): FrameOSMockFn<(typeof frameos)["code"]>;
  listAssets(impl?: (typeof frameos)["listAssets"]): FrameOSMockFn<(typeof frameos)["listAssets"]>;
  assetExists(impl?: (typeof frameos)["assetExists"]): FrameOSMockFn<(typeof frameos)["assetExists"]>;
  assetSize(impl?: (typeof frameos)["assetSize"]): FrameOSMockFn<(typeof frameos)["assetSize"]>;
  readAsset(impl?: (typeof frameos)["readAsset"]): FrameOSMockFn<(typeof frameos)["readAsset"]>;
  writeAsset(impl?: (typeof frameos)["writeAsset"]): FrameOSMockFn<(typeof frameos)["writeAsset"]>;
  appendAsset(impl?: (typeof frameos)["appendAsset"]): FrameOSMockFn<(typeof frameos)["appendAsset"]>;
  deleteAsset(impl?: (typeof frameos)["deleteAsset"]): FrameOSMockFn<(typeof frameos)["deleteAsset"]>;
  makeAssetFolder(impl?: (typeof frameos)["makeAssetFolder"]): FrameOSMockFn<(typeof frameos)["makeAssetFolder"]>;
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
  measureText(impl?: (typeof frameos)["measureText"]): FrameOSMockFn<(typeof frameos)["measureText"]>;
  log(impl?: (typeof frameos)["log"]): FrameOSMockFn<(typeof frameos)["log"]>;
  error(impl?: (typeof frameos)["error"]): FrameOSMockFn<(typeof frameos)["error"]>;
};
`
