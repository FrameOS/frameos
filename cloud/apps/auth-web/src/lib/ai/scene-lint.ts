// Structural linter for FrameOS scene JSON, run on every scene the AI
// delivers (and by the evals). validateScenePayload catches the shape
// ("is there a render event"); this catches the semantics the interpreter
// enforces at run time and that a model most often gets wrong: config keys
// that are not fields of the app, required inputs left unconnected, edge
// handles that the runtime ignores silently ("fieldOutput/image"), state
// nodes for undeclared fields, images wired into text inputs, split cells
// outside the grid, render apps dangling off the render chain.
//
// Errors block delivery and bounce back to the model as tool output;
// warnings are delivered with the scene so the model can choose to fix them.
// Mirrors frameos/src/frameos/interpreter.nim (edge pass) — keep in step.

import { appCatalog, sceneEvents, type AiAppConfig } from "./context";
import type { JsonObject } from "./scene-utils";

export type LintLevel = "error" | "warning";

export type LintIssue = {
  level: LintLevel;
  scene: string;
  node?: string;
  message: string;
};

export type LintResult = {
  errors: LintIssue[];
  warnings: LintIssue[];
};

type AppField = {
  name?: string;
  type?: string;
  required?: boolean;
  value?: unknown;
  options?: unknown;
  markdown?: string;
};

type ResolvedApp = {
  keyword: string;
  category?: string | undefined;
  fields: AppField[];
  outputType?: string | undefined;
  fieldNames: Set<string>;
  nodeFieldNames: Set<string>;
  source: "catalog" | "scene" | "inline";
};

const NODE_TYPES = new Set(["event", "dispatch", "app", "state", "code", "scene"]);
const FIELD_TYPES = new Set([
  "string",
  "text",
  "float",
  "integer",
  "boolean",
  "color",
  "date",
  "json",
  "node",
  "scene",
  "image",
  "font",
  "select",
  "path",
]);
// Value edges the interpreter accepts (interpreter.nim pass 2).
const VALUE_SOURCE_HANDLES = new Set(["fieldOutput", "stateOutput"]);
const CHAIN_SOURCE_TYPES = new Set(["event", "app", "scene", "dispatch"]);
const CHAIN_TARGET_TYPES = new Set(["app", "scene", "dispatch"]);
const IMAGE_LIKE = new Set(["image"]);

function obj(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function fieldsOf(config: JsonObject | AiAppConfig | undefined): AppField[] {
  const raw = (config as { fields?: unknown } | undefined)?.fields;
  return Array.isArray(raw)
    ? raw.filter((field): field is AppField => Boolean(obj(field)))
    : [];
}

function outputTypeOf(config: JsonObject | AiAppConfig | undefined): string | undefined {
  const raw = (config as { output?: unknown } | undefined)?.output;
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  return str(obj(raw[0])?.type);
}

function resolveApp(
  keyword: string,
  data: JsonObject,
  sceneApps: JsonObject | undefined,
  catalog: Record<string, AiAppConfig>,
): ResolvedApp | undefined {
  let config: JsonObject | AiAppConfig | undefined;
  let source: ResolvedApp["source"] = "catalog";
  const inlineSources = obj(data.sources);
  const inlineConfig = inlineSources ? parseJsonString(inlineSources["config.json"]) : undefined;
  if (inlineConfig) {
    config = inlineConfig;
    source = "inline";
  } else if (sceneApps && obj(sceneApps[keyword])) {
    config = obj(sceneApps[keyword]);
    source = "scene";
  } else if (catalog[keyword]) {
    config = catalog[keyword];
  } else {
    return undefined;
  }
  const fields = fieldsOf(config);
  const fieldNames = new Set<string>();
  const nodeFieldNames = new Set<string>();
  for (const field of fields) {
    if (typeof field.name !== "string" || !field.name) {
      continue;
    }
    fieldNames.add(field.name);
    if (field.type === "node") {
      nodeFieldNames.add(field.name);
    }
  }
  return {
    category: str((config as { category?: unknown }).category),
    fieldNames,
    fields,
    keyword,
    nodeFieldNames,
    outputType: outputTypeOf(config),
    source,
  };
}

function parseJsonString(value: unknown): JsonObject | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return obj(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function fieldOptions(fields: AppField[], name: string): Set<string> | undefined {
  // The same field name may appear several times with different showIf
  // conditions (data/openaiImage "size" per model); the union of their
  // options is what can legitimately be stored.
  const options = new Set<string>();
  let sawSelect = false;
  for (const field of fields) {
    if (field.name !== name || field.type !== "select") {
      continue;
    }
    sawSelect = true;
    for (const value of optionValues(field.options)) {
      options.add(value);
    }
  }
  return sawSelect && options.size > 0 ? options : undefined;
}

// A select option is either a plain string or a { value, label } pair (both
// strings). Anything else — a number, a half-filled object — is stored but
// unrenderable, so it never reaches the editor.
function optionShapeIssue(options: unknown): string | undefined {
  if (options === undefined || options === null) {
    return undefined;
  }
  if (!Array.isArray(options)) {
    return `"options" must be a list; got ${JSON.stringify(options)}`;
  }
  const bad = options.find((option) => {
    if (typeof option === "string") {
      return false;
    }
    const entry = obj(option);
    return !entry || typeof entry.value !== "string" || typeof entry.label !== "string";
  });
  if (bad === undefined) {
    return undefined;
  }
  return (
    `each option must be a string ("dark") or a { "value": "dark", "label": "Dark" } pair ` +
    `(both strings); got ${JSON.stringify(bad)}`
  );
}

// The values a select field can legitimately store.
function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) {
    return [];
  }
  const values: string[] = [];
  for (const option of options) {
    if (typeof option === "string") {
      values.push(option);
    } else {
      const value = obj(option)?.value;
      if (typeof value === "string") {
        values.push(value);
      }
    }
  }
  return values;
}

function hasDefault(fields: AppField[], name: string): boolean {
  return fields.some(
    (field) =>
      field.name === name &&
      field.value !== undefined &&
      field.value !== null &&
      String(field.value) !== "",
  );
}

function isRequired(fields: AppField[], name: string): boolean {
  return fields.some((field) => field.name === name && field.required === true);
}

function fieldType(fields: AppField[], name: string): string | undefined {
  return fields.find((field) => field.name === name)?.type;
}

function valueLooksLike(type: string | undefined, value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = typeof value === "string" ? value : String(value);
  if (text === "") {
    return undefined;
  }
  switch (type) {
    case "integer":
      return /^-?\d+$/.test(text.trim()) ? undefined : `expected an integer, got ${JSON.stringify(value)}`;
    case "float":
      return Number.isFinite(Number(text)) ? undefined : `expected a number, got ${JSON.stringify(value)}`;
    case "boolean":
      return text === "true" || text === "false"
        ? undefined
        : `expected "true" or "false", got ${JSON.stringify(value)}`;
    case "color":
      return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(text.trim())
        ? undefined
        : `expected a hex colour like "#112233", got ${JSON.stringify(value)}`;
    default:
      return undefined;
  }
}

// Time patterns the runtime's format()/parseTs() do NOT understand: anything
// strftime/moment-like passed as a quoted literal. The runtime copies letters
// outside {curly tokens} verbatim, so "HH:mm" renders as the text HH:mm.
const LEGACY_TIME_PATTERN = /\b(?:format|parseTs)\([^'"`]{0,80}?(['"`])([^'"`]{1,80})\1/g;
const STRFTIME_LIKE = /%[a-zA-Z]|\b(?:YYYY|yyyy|MMMM|MMM|MM|dddd|ddd|DD|dd|HH|hh|mm|ss|EEE|EEEE)\b/;

// SVG built by code should size itself from the frame; a literal viewBox
// with fixed numbers means the design is pinned to one panel size.
export function hardcodedCanvasSize(source: string): string | undefined {
  const match = /viewBox\s*=\s*["']\s*0\s+0\s+(\d{3,4})\s+(\d{3,4})\s*["']/.exec(source);
  return match ? `${match[1]}x${match[2]}` : undefined;
}

export function lintCodeNodeJs(code: string, argNames: string[] = []): string[] {
  const problems: string[] = [];
  // Declared codeArgs are injected as `const <name> = …` ahead of the
  // snippet; redeclaring one in the same scope is a SyntaxError on the frame
  // ("invalid redefinition of lexical identifier") that names no line.
  for (const name of argNames) {
    if (new RegExp(`(^|[^.\\w])(?:const|let|var|function|class)\\s+${name}\\b`).test(code)) {
      problems.push(
        `Code node redeclares its argument "${name}" (it is already defined as a const from codeArgs). Use it directly or copy it into a differently named variable.`,
      );
    }
  }
  if (/\bframeos\s*\./.test(code)) {
    problems.push(
      "Code nodes have no `frameos` object (no fetchJson/fetchText/svg/image there). Fetch with a data app (data/downloadUrl + data/parseJson) wired into a codeArg, and build SVG/text as a plain string.",
    );
  }
  if (/\bfetch\s*\(/.test(code) || /\bXMLHttpRequest\b/.test(code)) {
    problems.push("Code nodes cannot make HTTP requests (no fetch). Use a data app such as data/downloadUrl and pass its output in as a codeArg.");
  }
  for (const match of code.matchAll(LEGACY_TIME_PATTERN)) {
    const pattern = match[2] ?? "";
    if (!pattern.includes("{") && STRFTIME_LIKE.test(pattern)) {
      problems.push(
        `format()/parseTs() pattern ${JSON.stringify(pattern)} uses strftime/moment letters, which print literally. Use curly tokens: {year/4}-{month/2}-{day/2} {hour/2}:{minute/2}, {weekday}, {month/n}, {day}.`,
      );
    }
  }
  return problems;
}

// JS apps run in the app sandbox: frameos.* helpers exist, the code-node time
// helpers do not.
const mainAppSourceFile = /^app\.(ts|tsx|js|jsx)$/;
const importableAppFile = /\.(ts|tsx|js|jsx|json)$/;
const importExtensions = [".ts", ".tsx", ".js", ".jsx", ".json"];
// `import x from '…'`, `import { a } from '…'`, `import '…'`, `export { a } from '…'`.
const importSpecifierPattern = /^\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"\n]+)['"]|^\s*import\s*['"]([^'"\n]+)['"]/gm;

export function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(importSpecifierPattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** Mirrors the frame's loader: `./`/`../` relative to the importing file, then the usual extensions. */
export function resolveAppImport(fromFile: string, specifier: string, files: string[]): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const parts = fromFile.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  const joined = parts.join("/");
  const candidates = [joined, ...importExtensions.map((ext) => joined + ext)];
  if (joined.endsWith(".js")) {
    candidates.push(joined.slice(0, -3) + ".ts", joined.slice(0, -3) + ".tsx");
  } else if (joined.endsWith(".jsx")) {
    candidates.push(joined.slice(0, -4) + ".tsx");
  }
  return candidates.find((candidate) => files.includes(candidate));
}

/** Import problems in one of an app's files: npm packages, or files the app does not have. */
export function lintAppImports(file: string, source: string, files: string[]): string[] {
  const problems: string[] = [];
  const importable = files.filter((name) => importableAppFile.test(name));
  for (const specifier of importSpecifiers(source)) {
    if (!specifier.startsWith(".")) {
      problems.push(
        `imports "${specifier}" — npm packages are not available on a frame; an app can only import its own files (import { x } from "./helper", import data from "./data.json").`,
      );
    } else if (!resolveAppImport(file, specifier, importable)) {
      problems.push(
        `imports "${specifier}", but the app has no such file (its files: ${importable.join(", ") || "none"}). Add it to sources or fix the path.`,
      );
    }
  }
  return problems;
}

export function lintJsAppSource(source: string, category?: string): string[] {
  const problems: string[] = [];
  const exportsFn = (name: string) =>
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s+(?:const|let)\\s+${name}\\b|exports\\.${name}\\s*=`).test(source);
  // Verified 2026-08-24 against the wasm runtime: a scene-local app with
  // category "render" (run() returning frameos.svg) draws nothing and logs
  // nothing. The path that works is a DATA app whose get() returns the image,
  // wired into a render/image node — the Weather sample's weatherPanel.
  if (category === "render") {
    problems.push(
      'scene-local apps with category "render" draw nothing in the runtime. Make it category "data" with `export function get(app, context)` returning frameos.svg(...) (output [{name:"image", type:"image"}]) and wire its fieldOutput into a render/image node\'s "image" field.',
    );
  } else if (!exportsFn("get")) {
    problems.push(
      `a ${category ?? "data"}-category JS app must \`export function get(app, context)\` returning its output value; nothing else is called.`,
    );
  }
  if (/(^|[^.\w])(?:format|now|parseTs)\s*\(/.test(source)) {
    problems.push(
      "JS apps have no format()/now()/parseTs() (those exist only in code nodes). Use Date (UTC only) or take the formatted value in through a field fed by a code node or data/clock.",
    );
  }
  return problems;
}

// pixie's SVG subset (pixie pin of 2026-08-25): any unsupported tag fails
// the whole document; <defs> is read for its gradients only, so the tags
// below fail inside it too. Gradients must be userSpaceOnUse.
const SVG_UNSUPPORTED_TAGS = /<\s*(use|image|filter|mask|clipPath|pattern|style|foreignObject|symbol|marker|switch)\b/;

export function lintSvgMarkup(markup: string): string[] {
  const problems: string[] = [];
  if (!/<\s*svg\b/i.test(markup)) {
    return problems;
  }
  const unsupported = SVG_UNSUPPORTED_TAGS.exec(markup);
  if (unsupported) {
    problems.push(
      `SVG uses <${unsupported[1]}>, which the frame's renderer does not support — the WHOLE SVG fails to render. Supported: svg, g, path, rect, circle, ellipse, line, polyline, polygon, text/tspan, linearGradient, radialGradient, defs (gradients only).`,
    );
  }
  if (/<\s*svg\b(?![^>]*viewBox)/i.test(markup)) {
    problems.push("SVG root needs a viewBox attribute.");
  }
  for (const match of markup.matchAll(/<\s*(linearGradient|radialGradient)\b([^>]*)>/gi)) {
    const tag = match[1] ?? "gradient";
    const attrs = match[2] ?? "";
    if (!/gradientUnits\s*=\s*["']userSpaceOnUse["']/.test(attrs)) {
      problems.push(`${tag} needs gradientUnits="userSpaceOnUse" (objectBoundingBox, the default, is not supported).`);
    }
  }
  if (/\bstroke\s*=\s*["']url\(/.test(markup)) {
    problems.push("A stroke cannot reference a gradient (stroke=\"url(#...)\"); only fills can.");
  }
  return [...new Set(problems)];
}

// Model-written code sometimes arrives "minified" to save tokens: whole
// functions on one line. It runs, but nobody can read or edit it.
export function looksMinified(source: string): boolean {
  const lines = source.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return false;
  }
  const long = lines.filter((line) => line.length > 300).length;
  return long >= 3 || (long >= 1 && lines.length <= 6 && source.length > 1500);
}

function knownEventNames(): Set<string> {
  const names = new Set<string>();
  for (const event of sceneEvents()) {
    const name = str(obj(event)?.name);
    if (name) {
      names.add(name);
    }
  }
  return names;
}

export function lintScene(
  scene: JsonObject,
  options: {
    catalog?: Record<string, AiAppConfig>;
    allSceneIds?: Set<string>;
    sceneFieldsById?: Map<string, Set<string>>;
  } = {},
): LintIssue[] {
  const catalog = options.catalog ?? appCatalog();
  const issues: LintIssue[] = [];
  const sceneLabel = str(scene.name) || str(scene.id) || "scene";
  const push = (level: LintLevel, message: string, node?: string) => {
    issues.push({ level, message, scene: sceneLabel, ...(node ? { node } : {}) });
  };

  const nodes = Array.isArray(scene.nodes) ? scene.nodes.map(obj).filter(Boolean) as JsonObject[] : [];
  const edges = Array.isArray(scene.edges) ? scene.edges.map(obj).filter(Boolean) as JsonObject[] : [];
  const sceneApps = obj(scene.apps);
  const settings = obj(scene.settings) ?? {};

  // --- scene fields -------------------------------------------------------
  const declaredFields = new Map<string, JsonObject>();
  const rawFields = Array.isArray(scene.fields) ? scene.fields : [];
  rawFields.forEach((raw, index) => {
    const field = obj(raw);
    if (!field) {
      push("error", `fields[${index}] is not an object.`);
      return;
    }
    const name = str(field.name);
    if (!name) {
      push("error", `fields[${index}] has no name.`);
      return;
    }
    if (declaredFields.has(name)) {
      push("error", `Scene field "${name}" is declared twice.`);
    }
    declaredFields.set(name, field);
    const type = str(field.type);
    if (!type || !FIELD_TYPES.has(type)) {
      push(
        "error",
        `Scene field "${name}" has unknown type "${type ?? ""}". Allowed: ${[...FIELD_TYPES].join(", ")}.`,
      );
    }
    if (type === "select" && !(Array.isArray(field.options) && field.options.length > 0)) {
      push("error", `Scene field "${name}" is a select but has no options.`);
    }
    const optionIssue = optionShapeIssue(field.options);
    if (optionIssue) {
      push("error", `Scene field "${name}": ${optionIssue}.`);
    }
    if (field.value === undefined || field.value === null) {
      if (["integer", "float", "boolean", "select", "color"].includes(type ?? "")) {
        push("warning", `Scene field "${name}" (${type}) has no default "value"; give it a string default.`);
      }
    } else if (typeof field.value !== "string") {
      push(
        "warning",
        `Scene field "${name}" default should be a string (got ${typeof field.value}); the editor stores all field values as strings.`,
      );
    }
    const mismatch = valueLooksLike(type, field.value);
    if (mismatch) {
      push("warning", `Scene field "${name}": ${mismatch}.`);
    }
  });

  // --- scene-local JS apps --------------------------------------------------
  if (sceneApps) {
    for (const [keyword, raw] of Object.entries(sceneApps)) {
      for (const field of fieldsOf(obj(raw))) {
        const issue = optionShapeIssue(field.options);
        if (issue) {
          push("error", `Scene app "${keyword}" field "${str(field.name) ?? ""}": ${issue}.`);
        }
      }
      const sources = obj(obj(raw)?.sources) ?? {};
      const fileNames = Object.keys(sources);
      for (const [file, content] of Object.entries(sources)) {
        if (typeof content !== "string" || !/\.(ts|js|tsx|jsx)$/.test(file)) {
          continue;
        }
        // Only the main module must export get(); helpers export whatever
        // app.ts imports from them.
        const contract = mainAppSourceFile.test(file) ? lintJsAppSource(content, str(obj(raw)?.category)) : [];
        for (const problem of [...contract, ...lintAppImports(file, content, fileNames), ...lintSvgMarkup(content)]) {
          push("error", `Scene app "${keyword}" (${file}): ${problem}`);
        }
        const fixed = hardcodedCanvasSize(content);
        if (fixed) {
          push(
            "warning",
            `Scene app "${keyword}" (${file}) builds an SVG with a hard-coded viewBox (${fixed}); size it from app.frame.width/height so the scene adapts to other panels.`,
          );
        }
        if (looksMinified(content)) {
          push(
            "warning",
            `Scene app "${keyword}" (${file}) is packed onto very long lines; users edit this code in the scene editor, so format it normally (one statement per line).`,
          );
        }
      }
    }
  }

  // --- settings -----------------------------------------------------------
  if (settings.refreshInterval !== undefined) {
    const interval = Number(settings.refreshInterval);
    if (!Number.isFinite(interval) || interval <= 0) {
      push("error", `settings.refreshInterval must be a positive number of seconds.`);
    }
  }
  if (settings.backgroundColor !== undefined) {
    const mismatch = valueLooksLike("color", settings.backgroundColor);
    if (mismatch) {
      push("warning", `settings.backgroundColor: ${mismatch}.`);
    }
  }

  // --- nodes --------------------------------------------------------------
  const nodeById = new Map<string, JsonObject>();
  const appByNode = new Map<string, ResolvedApp>();
  const events = knownEventNames();
  const dispatchedKeywords = new Set<string>();
  let renderEvents = 0;
  for (const node of nodes) {
    const id = str(node.id);
    if (!id) {
      push("error", "A node has no id.");
      continue;
    }
    nodeById.set(id, node);
    const type = str(node.type);
    if (!type || !NODE_TYPES.has(type)) {
      push("error", `Node type "${type ?? ""}" is not one of ${[...NODE_TYPES].join("/")}.`, id);
      continue;
    }
    const data = obj(node.data) ?? {};
    if (type === "event") {
      const keyword = str(data.keyword);
      if (keyword === "render") {
        renderEvents += 1;
      }
    } else if (type === "dispatch") {
      const keyword = str(data.keyword);
      if (!keyword) {
        push("error", "Dispatch node has no keyword.", id);
      } else {
        dispatchedKeywords.add(keyword);
      }
    } else if (type === "state") {
      const keyword = str(data.keyword);
      if (!keyword) {
        push("error", "State node has no keyword.", id);
      } else if (!declaredFields.has(keyword)) {
        push(
          "error",
          `State node reads field "${keyword}" which is not declared in the scene's "fields" array. Add { name: "${keyword}", type, value, access: "public", persist: "disk" } there.`,
          id,
        );
      }
    } else if (type === "code") {
      const code = str(data.codeJS);
      if (!code || !code.trim()) {
        push("error", "Code node has an empty data.codeJS.", id);
      } else {
        const argNames = (Array.isArray(data.codeArgs) ? data.codeArgs : [])
          .map((arg) => str(obj(arg)?.name))
          .filter((name): name is string => Boolean(name));
        for (const problem of [...lintCodeNodeJs(code, argNames), ...lintSvgMarkup(code)]) {
          push("error", problem, id);
        }
        const fixed = hardcodedCanvasSize(code);
        if (fixed) {
          push(
            "warning",
            `Code node builds an SVG with a hard-coded viewBox (${fixed}); derive the size from context.imageWidth/imageHeight or a state field so the scene adapts to other panels.`,
            id,
          );
        }
      }
      const outputs = Array.isArray(data.codeOutputs) ? data.codeOutputs : [];
      if (outputs.length > 1) {
        push("warning", "Code nodes have exactly one output; only the first codeOutputs entry is used.", id);
      }
      if (IMAGE_LIKE.has(str(obj(outputs[0])?.type) ?? "")) {
        push(
          "error",
          'Code nodes cannot output images (codeOutputs type "image"). To draw generated SVG, output a "string" and feed it into a render/svg node\'s "svg" field; for a scene-local JS app, return frameos.svg(...) from get().',
          id,
        );
      }
      const args = Array.isArray(data.codeArgs) ? data.codeArgs : [];
      for (const arg of args) {
        const entry = obj(arg);
        if (!entry || !str(entry.name)) {
          push("error", "Every codeArgs entry needs { name, type }.", id);
        }
      }
    } else if (type === "scene") {
      const keyword = str(data.keyword);
      if (!keyword) {
        push("error", "Scene node has no keyword (the id of the scene to embed).", id);
      } else if (options.allSceneIds && !options.allSceneIds.has(keyword)) {
        push("warning", `Scene node embeds scene "${keyword}", which is not among the scenes provided.`, id);
      }
    } else if (type === "app") {
      const keyword = str(data.keyword);
      if (!keyword) {
        push("error", "App node has no keyword.", id);
        continue;
      }
      const app = resolveApp(keyword, data, sceneApps, catalog);
      if (!app) {
        push("error", `Unknown app keyword "${keyword}". Use search_apps to find valid keywords.`, id);
        continue;
      }
      appByNode.set(id, app);
      if (app.source === "inline") {
        for (const field of app.fields) {
          const issue = optionShapeIssue(field.options);
          if (issue) {
            push("error", `App ${keyword} field "${str(field.name) ?? ""}": ${issue}.`, id);
          }
        }
      }
      const config = obj(data.config) ?? {};
      for (const [key, value] of Object.entries(config)) {
        if (!app.fieldNames.has(key)) {
          push(
            "error",
            `App ${keyword} has no field "${key}". Its fields are: ${[...app.fieldNames].join(", ") || "(none)"}.`,
            id,
          );
          continue;
        }
        if (app.nodeFieldNames.has(key)) {
          push(
            "error",
            `App ${keyword} field "${key}" is a node slot: connect it with an appNodeEdge (sourceHandle "field/${key}" -> targetHandle "prev"), not through config.`,
            id,
          );
          continue;
        }
        if (value !== null && typeof value === "object") {
          push(
            "warning",
            `App ${keyword} config "${key}" should be a string (config values are strings; json fields take a JSON string).`,
            id,
          );
          continue;
        }
        if (key === "svg" && typeof value === "string") {
          for (const problem of lintSvgMarkup(value)) {
            push("error", `App ${keyword} "svg": ${problem}`, id);
          }
        }
        const options = fieldOptions(app.fields, key);
        if (options && !options.has(String(value))) {
          push(
            "error",
            `App ${keyword} field "${key}" must be one of ${[...options].map((o) => JSON.stringify(o)).join(", ")}; got ${JSON.stringify(value)}.`,
            id,
          );
        }
        const mismatch = valueLooksLike(fieldType(app.fields, key), value);
        if (mismatch) {
          push("warning", `App ${keyword} field "${key}": ${mismatch}.`, id);
        }
      }
      const cache = obj(data.cache);
      if (cache) {
        for (const key of Object.keys(cache)) {
          if (!["enabled", "inputEnabled", "durationEnabled", "duration", "expression", "expressionType", "expressionEnabled", "expressionJS"].includes(key)) {
            push("warning", `Unknown cache option "${key}" on app ${keyword}.`, id);
          }
        }
      }
    }
  }
  if (renderEvents > 1) {
    push("warning", `The scene has ${renderEvents} render event nodes; one is enough — every listener runs on each render.`);
  }
  for (const node of nodes) {
    const id = str(node.id);
    const data = obj(node.data) ?? {};
    if (node.type === "event") {
      const keyword = str(data.keyword);
      if (!keyword) {
        push("error", "Event node has no keyword.", id);
      } else if (!events.has(keyword) && !dispatchedKeywords.has(keyword)) {
        push(
          "warning",
          `Event node listens for "${keyword}", which is not a built-in event (${[...events].join(", ")}) and nothing in this scene dispatches it.`,
          id,
        );
      }
    }
  }

  // --- edges --------------------------------------------------------------
  const nextTargets = new Map<string, string[]>();
  const connectedInputs = new Map<string, Set<string>>();
  const codeArgsFed = new Map<string, Set<string>>();
  const chainAdjacency = new Map<string, string[]>();
  const valueSourcesUsed = new Set<string>();
  const addChain = (from: string, to: string) => {
    const list = chainAdjacency.get(from) ?? [];
    list.push(to);
    chainAdjacency.set(from, list);
  };

  edges.forEach((edge, index) => {
    const source = str(edge.source);
    const target = str(edge.target);
    const sourceNode = source ? nodeById.get(source) : undefined;
    const targetNode = target ? nodeById.get(target) : undefined;
    const label = str(edge.id) ?? `edges[${index}]`;
    if (!sourceNode || !targetNode || !source || !target) {
      // validateScenePayload already reports dangling ids.
      return;
    }
    const sourceHandle = str(edge.sourceHandle) ?? "";
    const targetHandle = str(edge.targetHandle) ?? "";
    const edgeType = str(edge.type);
    const sourceType = str(sourceNode.type) ?? "";
    const targetType = str(targetNode.type) ?? "";

    // Chain edges: next -> prev and field/<slot> -> prev.
    if (targetHandle === "prev") {
      if (edgeType && edgeType !== "appNodeEdge") {
        push("error", `Edge ${label} into "prev" must have type "appNodeEdge" (got "${edgeType}").`, source);
      }
      if (!CHAIN_TARGET_TYPES.has(targetType)) {
        push(
          "error",
          `Edge ${label}: "prev" targets must be app, scene or dispatch nodes; ${target} is a ${targetType} node. Code/state/data values connect with codeNodeEdge to fieldInput/<field> instead.`,
          source,
        );
        return;
      }
      if (sourceHandle === "next") {
        if (!CHAIN_SOURCE_TYPES.has(sourceType)) {
          push("error", `Edge ${label}: only event/app/scene/dispatch nodes have a "next" handle; ${source} is a ${sourceType} node.`, source);
          return;
        }
        const list = nextTargets.get(source) ?? [];
        list.push(target);
        nextTargets.set(source, list);
        addChain(source, target);
        return;
      }
      if (sourceHandle.startsWith("field/")) {
        const app = appByNode.get(source);
        if (!app) {
          push("error", `Edge ${label}: "field/…" source handles belong to app nodes; ${source} is a ${sourceType} node.`, source);
          return;
        }
        const path = sourceHandle.slice("field/".length);
        const baseName = path.replace(/\[.*$/, "");
        if (!app.nodeFieldNames.has(baseName)) {
          push(
            "error",
            `Edge ${label}: app ${app.keyword} has no node-typed field "${baseName}" (node slots: ${[...app.nodeFieldNames].join(", ") || "none"}).`,
            source,
          );
          return;
        }
        // render/split cells must lie inside the configured grid.
        const indices = [...path.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
        if (app.keyword === "render/split" && baseName === "render_functions" && indices.length === 2) {
          const config = obj(obj(sourceNode.data)?.config) ?? {};
          const rows = Number(config.rows ?? 1);
          const columns = Number(config.columns ?? 1);
          const [row, column] = indices as [number, number];
          if (row < 1 || column < 1 || row > rows || column > columns) {
            push(
              "error",
              `Edge ${label}: render/split cell [${row}][${column}] is outside its ${rows}x${columns} grid (rows/columns come from config; cells are 1-based).`,
              source,
            );
          }
        }
        addChain(source, target);
        return;
      }
      push(
        "error",
        `Edge ${label}: an edge into "prev" must come from sourceHandle "next" or "field/<nodeField>"; got "${sourceHandle}".`,
        source,
      );
      return;
    }

    // Value edges: fieldOutput/stateOutput -> fieldInput/<field> | codeField/<arg>.
    if (targetHandle.startsWith("fieldInput/") || targetHandle.startsWith("codeField/")) {
      if (edgeType && edgeType !== "codeNodeEdge") {
        push("error", `Edge ${label} into "${targetHandle}" must have type "codeNodeEdge" (got "${edgeType}").`, source);
      }
      if (!VALUE_SOURCE_HANDLES.has(sourceHandle) && !sourceHandle.startsWith("code/")) {
        push(
          "error",
          `Edge ${label}: value edges use sourceHandle "fieldOutput" exactly (got "${sourceHandle}"); the runtime ignores anything else.`,
          source,
        );
        return;
      }
      if (!["app", "code", "state"].includes(sourceType)) {
        push("error", `Edge ${label}: only app, code and state nodes produce values; ${source} is a ${sourceType} node.`, source);
        return;
      }
      valueSourcesUsed.add(source);
      const sourceValueType = valueTypeOfNode(sourceNode, appByNode, declaredFields);

      if (targetHandle.startsWith("fieldInput/")) {
        const fieldName = targetHandle.slice("fieldInput/".length);
        if (targetType === "scene") {
          // Sets a state field of the embedded scene before it runs.
          const embeddedId = str(obj(targetNode.data)?.keyword) ?? "";
          const embeddedFields = options.sceneFieldsById?.get(embeddedId);
          if (embeddedFields && !embeddedFields.has(fieldName)) {
            push(
              "warning",
              `Edge ${label}: embedded scene ${embeddedId} declares no field "${fieldName}" (its fields: ${[...embeddedFields].join(", ") || "none"}); the value is set as state anyway.`,
              target,
            );
          }
          if (IMAGE_LIKE.has(sourceValueType ?? "")) {
            push("error", `Edge ${label}: scene state cannot hold images (${source} outputs an image).`, target);
          }
          return;
        }
        if (targetType !== "app") {
          push("error", `Edge ${label}: "fieldInput/…" handles belong to app or scene nodes; ${target} is a ${targetType} node (code nodes take "codeField/<arg>").`, source);
          return;
        }
        const app = appByNode.get(target);
        if (!app) {
          return;
        }
        if (!app.fieldNames.has(fieldName)) {
          push(
            "error",
            `Edge ${label}: app ${app.keyword} has no field "${fieldName}". Its fields are: ${[...app.fieldNames].join(", ")}.`,
            target,
          );
          return;
        }
        if (app.nodeFieldNames.has(fieldName)) {
          push("error", `Edge ${label}: "${fieldName}" on ${app.keyword} is a node slot; wire it with sourceHandle "field/${fieldName}" -> "prev".`, target);
          return;
        }
        const targetFieldType = fieldType(app.fields, fieldName);
        const compatibility = typeCompatibility(sourceValueType, targetFieldType);
        if (compatibility) {
          push("error", `Edge ${label}: ${compatibility} (${source} -> ${app.keyword}.${fieldName}).`, target);
        }
        const set = connectedInputs.get(target) ?? new Set<string>();
        set.add(fieldName);
        connectedInputs.set(target, set);
        return;
      }

      const argName = targetHandle.slice("codeField/".length);
      if (targetType !== "code") {
        push("error", `Edge ${label}: "codeField/…" handles belong to code nodes; ${target} is a ${targetType} node.`, source);
        return;
      }
      const args = Array.isArray(obj(targetNode.data)?.codeArgs) ? (obj(targetNode.data)!.codeArgs as unknown[]) : [];
      const declared = args.map((arg) => str(obj(arg)?.name)).filter(Boolean) as string[];
      if (!declared.includes(argName)) {
        push(
          "error",
          `Edge ${label}: code node ${target} has no codeArgs entry named "${argName}" (declared: ${declared.join(", ") || "none"}). Add { name: "${argName}", type: "${sourceValueType ?? "string"}" } to its codeArgs.`,
          target,
        );
        return;
      }
      if (IMAGE_LIKE.has(sourceValueType ?? "")) {
        push("error", `Edge ${label}: code nodes cannot take images as arguments (${source} outputs an image).`, target);
      }
      const set = codeArgsFed.get(target) ?? new Set<string>();
      set.add(argName);
      codeArgsFed.set(target, set);
      return;
    }

    push(
      "error",
      `Edge ${label}: unknown handle pair sourceHandle "${sourceHandle}" -> targetHandle "${targetHandle}". Use next->prev, field/<slot>->prev, or fieldOutput->fieldInput/<field> | codeField/<arg>.`,
      source,
    );
  });

  // --- per-node follow-ups --------------------------------------------------
  for (const [source, targets] of nextTargets) {
    if (targets.length > 1) {
      push("error", `Node ${source} has ${targets.length} outgoing "next" edges; the chain is linear — at most one.`, source);
    }
  }

  for (const [nodeId, app] of appByNode) {
    const node = nodeById.get(nodeId)!;
    const config = obj(obj(node.data)?.config) ?? {};
    const connected = connectedInputs.get(nodeId) ?? new Set<string>();
    for (const field of app.fields) {
      const name = field.name;
      if (!name || field.type === "node" || field.type === "image") {
        continue;
      }
      if (
        isRequired(app.fields, name) &&
        !hasDefault(app.fields, name) &&
        !connected.has(name) &&
        (config[name] === undefined || config[name] === null || String(config[name]) === "")
      ) {
        push("error", `App ${app.keyword} requires field "${name}" — set it in config or connect a value to fieldInput/${name}.`, nodeId);
      }
    }
    for (const field of app.fields) {
      const name = field.name;
      if (!name || field.type !== "image" || name === "inputImage") {
        continue;
      }
      if (isRequired(app.fields, name) && !connected.has(name)) {
        push(
          "error",
          `App ${app.keyword} needs an image on "${name}": connect a data/render app's fieldOutput to fieldInput/${name}.`,
          nodeId,
        );
      }
    }
  }

  for (const node of nodes) {
    if (node.type !== "code") {
      continue;
    }
    const id = str(node.id)!;
    const args = Array.isArray(obj(node.data)?.codeArgs) ? (obj(node.data)!.codeArgs as unknown[]) : [];
    const fed = codeArgsFed.get(id) ?? new Set<string>();
    for (const arg of args) {
      const name = str(obj(arg)?.name);
      if (name && !fed.has(name)) {
        push("warning", `Code node ${id} declares argument "${name}" but nothing is connected to codeField/${name}; it will be undefined.`, id);
      }
    }
  }

  // --- reachability from the render event ----------------------------------
  const reachable = new Set<string>();
  const stack = nodes
    .filter((node) => node.type === "event")
    .map((node) => str(node.id)!)
    .filter(Boolean);
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    for (const next of chainAdjacency.get(current) ?? []) {
      stack.push(next);
    }
  }
  for (const [nodeId, app] of appByNode) {
    const inChain = reachable.has(nodeId);
    if ((app.category === "render" || app.category === "logic") && !inChain && !valueSourcesUsed.has(nodeId)) {
      push(
        "warning",
        `${app.category} app ${app.keyword} (${nodeId}) is not connected to any event chain and its output is unused; it will never run.`,
        nodeId,
      );
    }
    if (app.category === "data" && !valueSourcesUsed.has(nodeId) && !inChain) {
      push("warning", `Data app ${app.keyword} (${nodeId}) has no outgoing fieldOutput edge; its result is never used.`, nodeId);
    }
  }
  for (const node of nodes) {
    if (node.type === "state" && !valueSourcesUsed.has(str(node.id)!)) {
      push("warning", `State node ${str(node.id)} (${str(obj(node.data)?.keyword)}) is not connected to anything.`, str(node.id)!);
    }
    if (node.type === "code" && !valueSourcesUsed.has(str(node.id)!)) {
      push("warning", `Code node ${str(node.id)} output is not connected to anything.`, str(node.id)!);
    }
  }

  return issues;
}

function valueTypeOfNode(
  node: JsonObject,
  appByNode: Map<string, ResolvedApp>,
  declaredFields: Map<string, JsonObject>,
): string | undefined {
  const id = str(node.id) ?? "";
  if (node.type === "app") {
    return appByNode.get(id)?.outputType;
  }
  if (node.type === "code") {
    const outputs = Array.isArray(obj(node.data)?.codeOutputs) ? (obj(node.data)!.codeOutputs as unknown[]) : [];
    return str(obj(outputs[0])?.type);
  }
  if (node.type === "state") {
    const keyword = str(obj(node.data)?.keyword) ?? "";
    return str(declaredFields.get(keyword)?.type);
  }
  return undefined;
}

// Only the mismatches the runtime cannot coerce. Strings/json/numbers/booleans
// flow into each other (everything is a string in config anyway), but an
// image is a pixel buffer and cannot become text, and text cannot become an
// image.
function typeCompatibility(sourceType: string | undefined, targetType: string | undefined): string | undefined {
  if (!sourceType || !targetType) {
    return undefined;
  }
  const sourceIsImage = IMAGE_LIKE.has(sourceType);
  const targetIsImage = IMAGE_LIKE.has(targetType);
  if (sourceIsImage && !targetIsImage) {
    return `an image output cannot feed a ${targetType} field`;
  }
  if (!sourceIsImage && targetIsImage) {
    return `a ${sourceType} value cannot feed an image field (wire an app that outputs an image)`;
  }
  return undefined;
}

export function lintScenes(
  scenes: unknown[],
  options: { catalog?: Record<string, AiAppConfig> } = {},
): LintResult {
  const allSceneIds = new Set<string>();
  const sceneFieldsById = new Map<string, Set<string>>();
  for (const scene of scenes) {
    const entry = obj(scene);
    const id = str(entry?.id);
    if (id && entry) {
      allSceneIds.add(id);
      const names = new Set<string>();
      for (const field of Array.isArray(entry.fields) ? entry.fields : []) {
        const name = str(obj(field)?.name);
        if (name) {
          names.add(name);
        }
      }
      sceneFieldsById.set(id, names);
    }
  }
  const issues: LintIssue[] = [];
  for (const scene of scenes) {
    const entry = obj(scene);
    if (!entry) {
      continue;
    }
    issues.push(
      ...lintScene(entry, {
        allSceneIds,
        sceneFieldsById,
        ...(options.catalog ? { catalog: options.catalog } : {}),
      }),
    );
  }
  return {
    errors: issues.filter((issue) => issue.level === "error"),
    warnings: issues.filter((issue) => issue.level === "warning"),
  };
}

export function formatLintIssues(issues: LintIssue[]): string[] {
  return issues.map((issue) =>
    `${issue.scene}${issue.node ? ` / node ${issue.node}` : ""}: ${issue.message}`,
  );
}
