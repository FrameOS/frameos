// The converter: one compiled scene in, one interpreted scene out.
//
// Pass 1 (no model): structural fixes every compiled scene needs — code-node
// arguments whose names the JS envelope reserves are renamed and their edges
// rewritten, edges that name no argument are declared or dropped, source
// nodes are refused — and every Nim code node the expression grammar
// (nim-expression.ts) accepts gets its data.codeJS.
//
// Pass 2 (the model, when a ModelPort is given): one call per scene-local
// Nim app and per leftover code node, with the mapping tables as the
// instructions and the node's wiring as the input; the small lint in
// lint.ts feeds problems back for up to `maxAttempts` tries.
//
// The Nim does not survive the conversion: data.code goes the moment
// data.codeJS is written, app.nim/config.nim go the moment app.ts is — a
// converted scene carries no Nim at all (and a scene that already had both
// loses its leftover Nim the same way). Nim that nothing replaced
// (needs_manual_port) stays, so the scene still says what is missing.
// settings.convertedFrom records that the conversion happened.

import { lintConvertedApp, lintConvertedCodeNode } from "./lint";
import type { ModelPort } from "./model";
import { nimExpressionToJs, nimIdentifiers, NimConvertError } from "./nim-expression";
import { buildConvertInstructions, deliverConversionTool } from "./prompt";
import type {
  CodeArg,
  ConversionItem,
  ConversionReport,
  ConversionResult,
  JsonObject,
  ModelUsage,
  Scene,
  SceneApp,
  SceneEdge,
  SceneNode,
} from "./types";

export type ConvertOptions = {
  /** Without a port, pass 1 runs alone and the leftovers are reported as needs_model. */
  model?: ModelPort | undefined;
  /** Stamped into settings.convertedFrom; informational. */
  modelName?: string | undefined;
  /** The app sandbox's ambient .d.ts, when the caller has it (the cloud does). */
  typeDeclarations?: string | undefined;
  /** Model attempts per app / code node before giving up. Default 3. */
  maxAttempts?: number | undefined;
  /** "cloud" | "cli" | …, stamped into settings.convertedFrom. */
  tool?: string | undefined;
  now?: (() => Date) | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => void) | undefined;
};

// Names the code-node envelope refuses to declare as arguments
// (frameos/src/frameos/js_runtime/runtime.nim buildEnvelopeFunctionWithMap).
export const reservedCodeArgNames = new Set([
  "state",
  "args",
  "context",
  "console",
  "getargor",
  "parsets",
  "format",
  "now",
]);

export const javascriptAppSourceFiles = ["app.ts", "app.js", "app.tsx", "app.jsx"];

const hasText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function hasJavaScriptAppSource(sources: Record<string, string> | undefined): boolean {
  return !!sources && javascriptAppSourceFiles.some((file) => hasText(sources[file]));
}

export function hasNimOnlyAppSource(sources: Record<string, string> | undefined): boolean {
  return !!sources && (hasText(sources["app.nim"]) || hasText(sources["config.nim"])) && !hasJavaScriptAppSource(sources);
}

function nodeData(node: SceneNode): JsonObject {
  if (!node.data || typeof node.data !== "object") {
    node.data = {};
  }
  return node.data;
}

function sourcesOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [name, content] of Object.entries(value as Record<string, unknown>)) {
    if (typeof content === "string") {
      out[name] = content;
    }
  }
  return out;
}

/**
 * True when the scene holds content only the compiler can run. Mirrors
 * sceneRequiresCompilation (frontend/src/utils/sceneApps.ts) and
 * scene_requires_compilation (backend/app/utils/scene_execution.py).
 */
export function sceneRequiresCompilation(scene: Scene): boolean {
  const apps = scene.apps && typeof scene.apps === "object" ? scene.apps : {};
  if (Object.values(apps).some((app) => hasNimOnlyAppSource(sourcesOf(app?.sources)))) {
    return true;
  }
  return (scene.nodes ?? []).some((node) => {
    const data = node.data ?? {};
    if (node.type === "app") {
      const keyword = typeof data.keyword === "string" ? data.keyword : "";
      return hasNimOnlyAppSource(sourcesOf(data.sources)) || hasNimOnlyAppSource(sourcesOf(apps[keyword]?.sources));
    }
    if (node.type === "code") {
      return hasText(data.code) && !hasText(data.codeJS);
    }
    return node.type === "source";
  });
}

function codeArgsOf(data: JsonObject): CodeArg[] {
  if (!Array.isArray(data.codeArgs)) {
    return [];
  }
  return data.codeArgs
    .map((raw) => (raw && typeof raw === "object" ? (raw as JsonObject) : undefined))
    .filter((raw): raw is JsonObject => !!raw && typeof raw.name === "string" && raw.name.length > 0)
    .map((raw) => ({ name: raw.name as string, ...(typeof raw.type === "string" ? { type: raw.type } : {}) }));
}

function outputTypeOfNode(node: SceneNode | undefined, scene: Scene): string | undefined {
  if (!node) {
    return undefined;
  }
  const data = node.data ?? {};
  if (node.type === "code") {
    const outputs = Array.isArray(data.codeOutputs) ? data.codeOutputs : [];
    const first = outputs[0] as JsonObject | undefined;
    return typeof first?.type === "string" ? first.type : undefined;
  }
  if (node.type === "state") {
    const keyword = data.keyword;
    const field = (scene.fields ?? []).find((entry) => entry?.name === keyword);
    return typeof field?.type === "string" ? field.type : undefined;
  }
  return undefined;
}

function keywordOf(node: SceneNode | undefined): string {
  const keyword = node?.data?.keyword;
  return typeof keyword === "string" ? keyword : node?.type ?? "?";
}

function addUsage(total: ModelUsage, part: ModelUsage): ModelUsage {
  return {
    inputTokens: total.inputTokens + part.inputTokens,
    outputTokens: total.outputTokens + part.outputTokens,
    reasoningTokens: total.reasoningTokens + part.reasoningTokens,
  };
}

function uniqueName(base: string, taken: Set<string>): string {
  let candidate = base;
  let n = 2;
  while (taken.has(candidate) || reservedCodeArgNames.has(candidate.toLowerCase())) {
    candidate = `${base}${n}`;
    n += 1;
  }
  return candidate;
}

type PendingCode = {
  node: SceneNode;
  nim: string;
  args: CodeArg[];
  reason: string;
};

type PendingApp = {
  /** Node id, or `apps/<key>` for a scene app. */
  id: string;
  name: string;
  sources: Record<string, string>;
  /** Where converted files are written back to. */
  target: Record<string, string>;
  /** The node(s) that run this app. */
  nodes: SceneNode[];
  wiring: AppWiring;
};

type AppWiring = {
  inChain: boolean;
  feedsField: { targetKeyword: string; field: string }[];
  isRender: boolean;
  expectedExport: "get" | "run";
  expectedCategory: "data" | "logic";
  prevKeyword?: string | undefined;
  nextKeyword?: string | undefined;
  outputType?: string | undefined;
};

class SceneConverter {
  private readonly scene: Scene;
  private readonly nodesById = new Map<string, SceneNode>();
  private readonly items: ConversionItem[] = [];
  private modelCalls = 0;
  private usage: ModelUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  private modelName: string | undefined;
  private readonly instructions: string;
  private readonly maxAttempts: number;

  constructor(
    input: Scene,
    private readonly options: ConvertOptions,
  ) {
    this.scene = structuredClone(input);
    this.scene.nodes = Array.isArray(this.scene.nodes) ? this.scene.nodes : [];
    this.scene.edges = Array.isArray(this.scene.edges) ? this.scene.edges : [];
    for (const node of this.scene.nodes) {
      if (node && typeof node.id === "string") {
        this.nodesById.set(node.id, node);
      }
    }
    this.instructions = buildConvertInstructions({ typeDeclarations: options.typeDeclarations });
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.modelName = options.modelName;
  }

  private progress(message: string) {
    this.options.onProgress?.(message);
  }

  async run(): Promise<ConversionResult> {
    const settings = (this.scene.settings && typeof this.scene.settings === "object" ? this.scene.settings : {}) as JsonObject;
    this.scene.settings = settings;
    const explicit = settings.execution === "compiled" || settings.execution === "interpreted" ? settings.execution : undefined;
    const requiredBefore = sceneRequiresCompilation(this.scene);
    const executionBefore = explicit ?? (requiredBefore ? "compiled" : "interpreted");

    this.refuseSourceNodes();
    const pendingCode = this.convertCodeNodes();
    const pendingApps = this.collectApps();

    if (this.options.model) {
      for (const app of pendingApps) {
        await this.convertApp(app);
      }
      for (const pending of pendingCode) {
        await this.convertCodeNodeWithModel(pending);
      }
    } else {
      for (const app of pendingApps) {
        this.items.push({ id: app.id, kind: "app", name: app.name, reason: "scene-local Nim app: needs the model", status: "needs_model" });
      }
      for (const pending of pendingCode) {
        this.items.push({ kind: "code", nim: pending.nim, nodeId: pending.node.id, reason: pending.reason, status: "needs_model" });
      }
    }

    const needsModel = this.items.filter((item) => item.status === "needs_model").map(itemId);
    const needsManualPort = this.items.filter((item) => item.status === "needs_manual_port").map(itemId);
    const convertedSomething = this.items.some((item) => item.status === "converted");
    const stillCompiled = needsModel.length > 0 || needsManualPort.length > 0 || sceneRequiresCompilation(this.scene);

    let executionAfter: "compiled" | "interpreted";
    if (stillCompiled) {
      executionAfter = "compiled";
      if (explicit !== "interpreted") {
        settings.execution = "compiled";
      } else {
        // The scene claims to be interpreted while carrying Nim nothing runs;
        // leave the claim alone (that is the user's setting) and let the
        // report say what is wrong.
        executionAfter = "interpreted";
      }
    } else {
      executionAfter = "interpreted";
      if (explicit !== "interpreted" || convertedSomething) {
        settings.execution = "interpreted";
      }
      if (convertedSomething || explicit === "compiled") {
        settings.convertedFrom = {
          at: (this.options.now?.() ?? new Date()).toISOString(),
          execution: executionBefore,
          ...(this.modelName ? { model: this.modelName } : {}),
          tool: this.options.tool ?? "scene-convert",
        };
      }
    }

    return {
      report: {
        executionAfter,
        executionBefore,
        items: this.items,
        model: this.modelName,
        modelCalls: this.modelCalls,
        needsManualPort,
        needsModel,
        sceneId: this.scene.id,
        sceneName: typeof this.scene.name === "string" ? this.scene.name : this.scene.id,
        usage: this.usage,
      },
      scene: this.scene,
    };
  }

  // --- pass 1 -----------------------------------------------------------------

  private refuseSourceNodes() {
    for (const node of this.scene.nodes ?? []) {
      if (node.type !== "source") {
        continue;
      }
      const reason = "source nodes are compiled into the binary; nothing can run them — rebuild this part with nodes";
      nodeData(node).needsConversion = { reason, source: "source" };
      this.items.push({ kind: "source", nodeId: node.id, reason, status: "needs_manual_port" });
    }
  }

  private convertCodeNodes(): PendingCode[] {
    const pending: PendingCode[] = [];
    for (const node of this.scene.nodes ?? []) {
      if (node.type !== "code") {
        continue;
      }
      const data = nodeData(node);
      if (!hasText(data.code)) {
        continue;
      }
      if (hasText(data.codeJS)) {
        delete data.code;
        this.items.push({ kind: "code", nodeId: node.id, status: "already_javascript" });
        continue;
      }
      const nim = data.code;
      const args = this.fixCodeNodeArgs(node, nim);
      const rename = this.renameReservedArgs(node, args);
      try {
        const js = nimExpressionToJs(nim, { args, rename });
        data.codeJS = js;
        delete data.code;
        this.items.push({ js, kind: "code", nim, nodeId: node.id, status: "converted", via: "deterministic" });
      } catch (error) {
        if (!(error instanceof NimConvertError)) {
          throw error;
        }
        const renamed = args.map((arg) => ({ ...arg, name: rename[arg.name] ?? arg.name }));
        pending.push({ args: renamed, nim, node, reason: `${error.message} (at ${error.position})` });
      }
    }
    return pending;
  }

  /** Declare the inbound edges the code uses, drop the ones it does not, normalise handles. */
  private fixCodeNodeArgs(node: SceneNode, nim: string): CodeArg[] {
    const data = nodeData(node);
    const args = codeArgsOf(data);
    const declared = new Set(args.map((arg) => arg.name));
    const referenced = nimIdentifiers(nim);
    const seen = new Set<string>();
    const kept: SceneEdge[] = [];
    for (const edge of this.scene.edges ?? []) {
      if (edge.target !== node.id || typeof edge.targetHandle !== "string") {
        kept.push(edge);
        continue;
      }
      const handle = edge.targetHandle;
      const prefix = handle.startsWith("codeField/") ? "codeField/" : handle.startsWith("codeArg/") ? "codeArg/" : undefined;
      if (!prefix) {
        kept.push(edge);
        continue;
      }
      const name = handle.slice(prefix.length);
      const edgeId = edge.id ?? `${edge.source}->${edge.target}:${handle}`;
      if (seen.has(name)) {
        this.items.push({ edgeId, handle, kind: "edge", nodeId: node.id, reason: `a second edge into "${name}"; the first one stays`, status: "dropped" });
        continue;
      }
      if (!declared.has(name)) {
        if (!referenced.has(name)) {
          this.items.push({ edgeId, handle, kind: "edge", nodeId: node.id, reason: `the code never uses "${name}" and codeArgs does not declare it`, status: "dropped" });
          continue;
        }
        const type = outputTypeOfNode(this.nodesById.get(edge.source), this.scene) ?? "string";
        args.push({ name, type });
        declared.add(name);
        this.items.push({ edgeId, handle, kind: "edge", nodeId: node.id, reason: `the code uses "${name}"; declared it as a ${type} argument`, status: "declared" });
      }
      seen.add(name);
      if (prefix === "codeArg/") {
        // The interpreter only reads codeField/ handles.
        edge.targetHandle = `codeField/${name}`;
        this.items.push({ edgeId, handle, kind: "edge", nodeId: node.id, reason: "the interpreter reads codeField/ handles only", status: "rewritten" });
      }
      kept.push(edge);
    }
    this.scene.edges = kept;
    data.codeArgs = args.map((arg) => ({ name: arg.name, type: arg.type ?? "string" }));
    return args;
  }

  /** Rename arguments the envelope would silently skip; rewrite their edges. */
  private renameReservedArgs(node: SceneNode, args: CodeArg[]): Record<string, string> {
    const rename: Record<string, string> = {};
    const taken = new Set(args.map((arg) => arg.name));
    for (const arg of args) {
      if (!reservedCodeArgNames.has(arg.name.toLowerCase())) {
        continue;
      }
      const next = uniqueName(`${arg.name}Value`, taken);
      taken.add(next);
      rename[arg.name] = next;
      this.items.push({
        from: arg.name,
        kind: "arg",
        nodeId: node.id,
        reason: `"${arg.name}" is a reserved name in the JavaScript code-node envelope and would not be declared`,
        status: "renamed",
        to: next,
      });
    }
    if (Object.keys(rename).length === 0) {
      return rename;
    }
    const data = nodeData(node);
    data.codeArgs = args.map((arg) => ({ name: rename[arg.name] ?? arg.name, type: arg.type ?? "string" }));
    for (const edge of this.scene.edges ?? []) {
      if (edge.target !== node.id || typeof edge.targetHandle !== "string" || !edge.targetHandle.startsWith("codeField/")) {
        continue;
      }
      const name = edge.targetHandle.slice("codeField/".length);
      const next = rename[name];
      if (next) {
        edge.targetHandle = `codeField/${next}`;
      }
    }
    return rename;
  }

  private collectApps(): PendingApp[] {
    const pending: PendingApp[] = [];
    const apps = this.scene.apps && typeof this.scene.apps === "object" ? this.scene.apps : {};
    const nodesWithInline = new Set<string>();
    for (const node of this.scene.nodes ?? []) {
      if (node.type !== "app") {
        continue;
      }
      const data = nodeData(node);
      const sources = sourcesOf(data.sources);
      if (sources && hasJavaScriptAppSource(sources) && stripNimSources(sources)) {
        data.sources = sources;
        this.items.push({ id: node.id, kind: "app", name: appName(sources, keywordOf(node)), status: "already_javascript" });
        continue;
      }
      if (sources && hasNimOnlyAppSource(sources)) {
        nodesWithInline.add(node.id);
        data.sources = sources;
        pending.push({
          id: node.id,
          name: appName(sources, typeof data.name === "string" ? data.name : keywordOf(node)),
          nodes: [node],
          sources,
          target: sources,
          wiring: this.wiringOf([node], sources),
        });
      }
    }
    for (const [key, app] of Object.entries(apps)) {
      const sources = sourcesOf((app as SceneApp | undefined)?.sources);
      if (sources && hasJavaScriptAppSource(sources) && stripNimSources(sources)) {
        (app as SceneApp).sources = sources;
        this.items.push({ id: `apps/${key}`, kind: "app", name: appName(sources, key), status: "already_javascript" });
        continue;
      }
      if (!sources || !hasNimOnlyAppSource(sources)) {
        continue;
      }
      (app as SceneApp).sources = sources;
      const nodes = (this.scene.nodes ?? []).filter(
        (node) => node.type === "app" && node.data?.keyword === key && !nodesWithInline.has(node.id),
      );
      pending.push({
        id: `apps/${key}`,
        name: appName(sources, typeof (app as SceneApp).name === "string" ? ((app as SceneApp).name as string) : key),
        nodes,
        sources,
        target: sources,
        wiring: this.wiringOf(nodes, sources),
      });
    }
    return pending;
  }

  private wiringOf(nodes: SceneNode[], sources: Record<string, string>): AppWiring {
    const ids = new Set(nodes.map((node) => node.id));
    let inChain = false;
    const feedsField: AppWiring["feedsField"] = [];
    let prevKeyword: string | undefined;
    let nextKeyword: string | undefined;
    for (const edge of this.scene.edges ?? []) {
      if (ids.has(edge.target) && edge.targetHandle === "prev") {
        inChain = true;
        prevKeyword = keywordOf(this.nodesById.get(edge.source));
      }
      if (ids.has(edge.source) && edge.sourceHandle === "next") {
        inChain = true;
        nextKeyword = keywordOf(this.nodesById.get(edge.target));
      }
      if (ids.has(edge.source) && edge.sourceHandle === "fieldOutput" && typeof edge.targetHandle === "string") {
        feedsField.push({
          field: edge.targetHandle.replace(/^fieldInput\//, ""),
          targetKeyword: keywordOf(this.nodesById.get(edge.target)),
        });
      }
    }
    const config = parseConfig(sources);
    const category = typeof config?.category === "string" ? config.category : undefined;
    const nim = sources["app.nim"] ?? "";
    const isRender = category === "render" || /proc\s+render\*?\s*\(/.test(nim);
    const hasGet = /proc\s+get\*?\s*\(/.test(nim);
    const outputs = Array.isArray(config?.output) ? (config.output as JsonObject[]) : [];
    const outputType = typeof outputs[0]?.type === "string" ? (outputs[0].type as string) : undefined;
    const expectedExport: "get" | "run" = feedsField.length > 0 || hasGet || (isRender && !inChain) || (isRender && inChain) ? "get" : "run";
    return {
      expectedCategory: expectedExport === "get" ? "data" : "logic",
      expectedExport,
      feedsField,
      inChain,
      isRender,
      nextKeyword,
      outputType: isRender ? "image" : outputType,
      prevKeyword,
    };
  }

  // --- pass 2 -----------------------------------------------------------------

  private async callModel(input: string): Promise<{ args: JsonObject | undefined; text: string }> {
    const port = this.options.model!;
    this.modelCalls += 1;
    const result = await port({ input, instructions: this.instructions, tool: deliverConversionTool }, this.options.signal);
    this.usage = addUsage(this.usage, result.usage);
    this.modelName = result.model || this.modelName;
    const args = result.arguments && typeof result.arguments === "object" && !Array.isArray(result.arguments)
      ? (result.arguments as JsonObject)
      : undefined;
    return { args, text: result.text };
  }

  private async convertApp(app: PendingApp) {
    this.progress(`converting app "${app.name}"`);
    const baseInput = this.appInput(app);
    const feedback: string[] = [];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const input = feedback.length
        ? `${baseInput}\n\nThe previous attempt was rejected:\n${feedback.map((line) => `- ${line}`).join("\n")}\nDeliver a corrected version.`
        : baseInput;
      const { args, text } = await this.callModel(input);
      if (!args) {
        feedback.splice(0, feedback.length, `no ${deliverConversionTool.name} call was made${text ? ` (you wrote: ${text.slice(0, 200)})` : ""}`);
        continue;
      }
      if (hasText(args.unsupported)) {
        this.markAppUnsupported(app, args.unsupported.trim());
        return;
      }
      const files = sourcesOf(args.files);
      if (!files || Object.keys(files).length === 0) {
        feedback.splice(0, feedback.length, "the call carried no files");
        continue;
      }
      const merged = this.mergeAppFiles(app, files);
      const problems = lintConvertedApp(merged, app.wiring.expectedExport, categoryOf(merged));
      if (problems.length > 0) {
        feedback.splice(0, feedback.length, ...problems);
        continue;
      }
      for (const [name, content] of Object.entries(merged)) {
        app.target[name] = content;
      }
      stripNimSources(app.target);
      const insertedRenderImageNodeId = app.wiring.isRender && app.wiring.inChain ? this.insertRenderImage(app) : undefined;
      this.items.push({
        attempts: attempt,
        category: categoryOf(merged) ?? app.wiring.expectedCategory,
        files: Object.keys(files),
        id: app.id,
        kind: "app",
        name: app.name,
        status: "converted",
        via: "model",
        ...(insertedRenderImageNodeId ? { insertedRenderImageNodeId } : {}),
      });
      return;
    }
    this.markAppUnsupported(app, `the model produced no acceptable port in ${this.maxAttempts} attempts: ${feedback.join("; ")}`);
  }

  private markAppUnsupported(app: PendingApp, reason: string) {
    const note = { at: (this.options.now?.() ?? new Date()).toISOString(), reason, source: "app.nim" };
    for (const node of app.nodes) {
      nodeData(node).needsConversion = note;
    }
    if (app.id.startsWith("apps/")) {
      const key = app.id.slice("apps/".length);
      const entry = this.scene.apps?.[key];
      if (entry) {
        entry.needsConversion = note;
      }
    }
    this.items.push({ id: app.id, kind: "app", name: app.name, reason, status: "needs_manual_port" });
  }

  /** The delivered files over the originals, with config.json made consistent with the wiring. */
  private mergeAppFiles(app: PendingApp, files: Record<string, string>): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const [name, content] of Object.entries(app.sources)) {
      if (name === "app.nim" || name === "config.nim") {
        continue;
      }
      merged[name] = content;
    }
    Object.assign(merged, files);
    const config = parseConfig(merged) ?? parseConfig(app.sources) ?? {};
    if (!hasText(config.name)) {
      config.name = app.name;
    }
    const category = typeof config.category === "string" ? config.category : undefined;
    if (app.wiring.expectedExport === "run") {
      if (category !== "logic") {
        config.category = "logic";
      }
    } else if (category !== "data") {
      config.category = "data";
    }
    if (app.wiring.isRender) {
      config.output = [{ name: "image", type: "image" }];
    } else if (app.wiring.expectedExport === "get" && !Array.isArray(config.output)) {
      config.output = [{ name: "output", type: app.wiring.outputType ?? "string" }];
    }
    merged["config.json"] = JSON.stringify(config, null, 2);
    return merged;
  }

  /** A former render app becomes a data app: wire a render/image node into its chain slot. */
  private insertRenderImage(app: PendingApp): string | undefined {
    let inserted: string | undefined;
    for (const node of app.nodes) {
      const id = globalThis.crypto.randomUUID();
      const position = (node.position && typeof node.position === "object" ? node.position : { x: 0, y: 0 }) as { x?: number; y?: number };
      const renderImage: SceneNode = {
        data: { config: {}, keyword: "render/image" },
        id,
        position: { x: (position.x ?? 0) + 320, y: position.y ?? 0 },
        type: "app",
      };
      this.scene.nodes!.push(renderImage);
      this.nodesById.set(id, renderImage);
      for (const edge of this.scene.edges ?? []) {
        if (edge.target === node.id && edge.targetHandle === "prev") {
          edge.target = id;
        } else if (edge.source === node.id && edge.sourceHandle === "next") {
          edge.source = id;
        }
      }
      this.scene.edges!.push({
        id: globalThis.crypto.randomUUID(),
        source: node.id,
        sourceHandle: "fieldOutput",
        target: id,
        targetHandle: "fieldInput/image",
        type: "codeNodeEdge",
      });
      inserted = id;
    }
    return inserted;
  }

  private appInput(app: PendingApp): string {
    const wiring = app.wiring;
    const lines = [
      "Convert this scene-local Nim app to a JavaScript app for the FrameOS interpreter.",
      "",
      `App: "${app.name}" (${app.id.startsWith("apps/") ? `scene app "${app.id.slice(5)}"` : `inline on node ${app.id}`}), used by ${app.nodes.length} node(s).`,
    ];
    if (wiring.isRender && wiring.inChain) {
      lines.push(
        `Wiring: a RENDER app in the render chain${wiring.prevKeyword ? ` after ${wiring.prevKeyword}` : ""}${wiring.nextKeyword ? ` before ${wiring.nextKeyword}` : ""}.`,
        "It becomes a DATA app: `export function get(app, context)` returning frameos.svg(...) sized app.frame.width × app.frame.height; the converter inserts a render/image node after it. config.json: category \"data\", output [{\"name\": \"image\", \"type\": \"image\"}].",
      );
    } else if (wiring.expectedExport === "run") {
      lines.push(
        `Wiring: sits in the render chain${wiring.prevKeyword ? ` after ${wiring.prevKeyword}` : ""}${wiring.nextKeyword ? ` before ${wiring.nextKeyword}` : ""} → \`export function run(app, context)\`; config.json category "logic".`,
      );
    } else {
      const consumers = wiring.feedsField.map((entry) => `${entry.targetKeyword}.${entry.field}`).join(", ");
      lines.push(
        `Wiring: feeds ${consumers || "a field"} → \`export function get(app, context)\` returning the value (output type ${wiring.outputType ?? "as declared"}); config.json category "data".`,
      );
    }
    for (const node of app.nodes) {
      const config = node.data?.config;
      if (config && typeof config === "object" && Object.keys(config as object).length > 0) {
        lines.push(`Node ${node.id} config: ${JSON.stringify(config)}`);
      }
    }
    lines.push("", this.sceneContext(), "");
    for (const [name, content] of Object.entries(app.sources)) {
      lines.push(`--- ${name} ---`, content, "");
    }
    return lines.join("\n");
  }

  private sceneContext(): string {
    const fields = (this.scene.fields ?? [])
      .map((field) => (typeof field?.name === "string" ? `${field.name} (${typeof field.type === "string" ? field.type : "?"})` : undefined))
      .filter(Boolean);
    const stateReaders = new Set<string>();
    for (const node of this.scene.nodes ?? []) {
      const data = node.data ?? {};
      if (node.type === "state" && typeof data.keyword === "string") {
        stateReaders.add(`${data.keyword} (state node)`);
      }
      if (node.type === "app" && data.keyword === "logic/setAsState") {
        const key = (data.config as JsonObject | undefined)?.stateKey;
        if (typeof key === "string") {
          stateReaders.add(`${key} (written by logic/setAsState)`);
        }
      }
      for (const source of [data.code, data.codeJS]) {
        if (typeof source !== "string") {
          continue;
        }
        for (const match of source.matchAll(/state(?:\{"([^"]+)"\}|\.([A-Za-z_$][\w$]*))/g)) {
          stateReaders.add(`${match[1] ?? match[2]} (code node)`);
        }
      }
    }
    return [
      `Scene "${typeof this.scene.name === "string" ? this.scene.name : this.scene.id}".`,
      `Scene fields: ${fields.length ? fields.join(", ") : "none"}.`,
      `State keys other nodes use: ${stateReaders.size ? [...stateReaders].join(", ") : "none seen"}.`,
    ].join("\n");
  }

  private async convertCodeNodeWithModel(pending: PendingCode) {
    const { node, nim, args } = pending;
    this.progress(`converting code node ${node.id}`);
    const data = nodeData(node);
    const outputs = Array.isArray(data.codeOutputs) ? (data.codeOutputs as JsonObject[]) : [];
    const output = outputs[0];
    const feeders = args.map((arg) => {
      const edge = (this.scene.edges ?? []).find((entry) => entry.target === node.id && entry.targetHandle === `codeField/${arg.name}`);
      const source = edge ? this.nodesById.get(edge.source) : undefined;
      return `- ${arg.name}: ${arg.type ?? "string"}${source ? ` (fed by ${keywordOf(source)} node ${source.id})` : " (not connected)"}`;
    });
    const consumers = (this.scene.edges ?? [])
      .filter((edge) => edge.source === node.id)
      .map((edge) => `${keywordOf(this.nodesById.get(edge.target))} ${edge.targetHandle ?? ""}`.trim());
    const baseInput = [
      "Convert this Nim code-node expression to ONE JavaScript expression (data.codeJS).",
      `Pass 1 could not: ${pending.reason}.`,
      "",
      `Code node ${node.id}. Arguments (already declared under these exact names):`,
      ...(feeders.length ? feeders : ["- none"]),
      `Output: ${output ? `${String(output.name ?? "value")} (${String(output.type ?? "string")})` : "one value"}${consumers.length ? `, consumed by ${consumers.join(", ")}` : ""}.`,
      "",
      this.sceneContext(),
      "",
      "--- Nim ---",
      nim,
    ].join("\n");
    const feedback: string[] = [];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const input = feedback.length
        ? `${baseInput}\n\nThe previous attempt was rejected:\n${feedback.map((line) => `- ${line}`).join("\n")}\nDeliver a corrected expression.`
        : baseInput;
      const { args: delivered, text } = await this.callModel(input);
      if (!delivered) {
        feedback.splice(0, feedback.length, `no ${deliverConversionTool.name} call was made${text ? ` (you wrote: ${text.slice(0, 200)})` : ""}`);
        continue;
      }
      if (hasText(delivered.unsupported)) {
        this.markCodeUnsupported(node, nim, delivered.unsupported.trim());
        return;
      }
      const codeJS = typeof delivered.codeJS === "string" ? delivered.codeJS.trim() : "";
      const problems = lintConvertedCodeNode(codeJS, args.map((arg) => arg.name));
      if (problems.length > 0) {
        feedback.splice(0, feedback.length, ...problems);
        continue;
      }
      data.codeJS = codeJS;
      delete data.code;
      this.items.push({ attempts: attempt, js: codeJS, kind: "code", nim, nodeId: node.id, status: "converted", via: "model" });
      return;
    }
    this.markCodeUnsupported(node, nim, `the model produced no acceptable expression in ${this.maxAttempts} attempts: ${feedback.join("; ")}`);
  }

  private markCodeUnsupported(node: SceneNode, nim: string, reason: string) {
    nodeData(node).needsConversion = { at: (this.options.now?.() ?? new Date()).toISOString(), reason, source: "code" };
    this.items.push({ kind: "code", nim, nodeId: node.id, reason, status: "needs_manual_port" });
  }
}

/** Remove app.nim / config.nim; true when there was any. */
function stripNimSources(sources: Record<string, string>): boolean {
  let stripped = false;
  for (const name of ["app.nim", "config.nim"]) {
    if (name in sources) {
      delete sources[name];
      stripped = true;
    }
  }
  return stripped;
}

function itemId(item: ConversionItem): string {
  switch (item.kind) {
    case "app":
      return item.id;
    case "edge":
      return item.edgeId;
    default:
      return item.nodeId;
  }
}

function parseConfig(sources: Record<string, string>): JsonObject | undefined {
  const raw = sources["config.json"];
  if (!hasText(raw)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

function categoryOf(sources: Record<string, string>): string | undefined {
  const category = parseConfig(sources)?.category;
  return typeof category === "string" ? category : undefined;
}

function appName(sources: Record<string, string>, fallback: string): string {
  const name = parseConfig(sources)?.name;
  return typeof name === "string" && name.trim() ? name.trim() : fallback;
}

/** Convert one scene. Never throws for a scene the grammar rejects; only for transport failures of the model port. */
export async function convertScene(scene: Scene, options: ConvertOptions = {}): Promise<ConversionResult> {
  if (!scene || typeof scene !== "object" || typeof scene.id !== "string") {
    throw new TypeError("a scene is an object with a string id");
  }
  return new SceneConverter(scene, options).run();
}

export async function convertScenes(scenes: Scene[], options: ConvertOptions = {}): Promise<ConversionResult[]> {
  const results: ConversionResult[] = [];
  for (const scene of scenes) {
    results.push(await convertScene(scene, options));
  }
  return results;
}

/** One line per item, for terminals and the page. */
export function describeReport(report: ConversionReport): string[] {
  const lines: string[] = [];
  for (const item of report.items) {
    switch (item.kind) {
      case "code":
        if (item.status === "converted") {
          lines.push(`code ${short(item.nodeId)}: ${item.via} — ${item.nim.replace(/\s+/g, " ")} → ${item.js.replace(/\s+/g, " ")}`);
        } else if (item.status === "already_javascript") {
          lines.push(`code ${short(item.nodeId)}: already has codeJS — leftover Nim removed`);
        } else {
          lines.push(`code ${short(item.nodeId)}: ${item.status.replace(/_/g, " ")} — ${item.reason}`);
        }
        break;
      case "app":
        if (item.status === "converted") {
          lines.push(
            `app "${item.name}": converted by the model (${item.files.join(", ")}, ${item.attempts} attempt${item.attempts === 1 ? "" : "s"})${item.insertedRenderImageNodeId ? `, render/image ${short(item.insertedRenderImageNodeId)} inserted` : ""}`,
          );
        } else if (item.status === "already_javascript") {
          lines.push(`app "${item.name}": already JavaScript — leftover Nim sources removed`);
        } else {
          lines.push(`app "${item.name}": ${item.status.replace(/_/g, " ")} — ${item.reason}`);
        }
        break;
      case "source":
        lines.push(`source node ${short(item.nodeId)}: needs manual port — ${item.reason}`);
        break;
      case "arg":
        lines.push(`code ${short(item.nodeId)}: argument "${item.from}" renamed to "${item.to}" — ${item.reason}`);
        break;
      case "edge":
        lines.push(`code ${short(item.nodeId)}: edge ${item.handle} ${item.status} — ${item.reason}`);
        break;
    }
  }
  lines.push(
    `execution: ${report.executionBefore} → ${report.executionAfter}; model calls: ${report.modelCalls}${report.needsModel.length ? `; needs the model: ${report.needsModel.length}` : ""}${report.needsManualPort.length ? `; needs a manual port: ${report.needsManualPort.length}` : ""}`,
  );
  return lines;
}

function short(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
