// AI scene chat for the cloud workspace — a scoped TypeScript port of the
// self-hosted backend's backend/app/utils/ai_scene.py (prompts + OpenAI
// calls) plus the pure post-processing helpers from
// backend/app/api/ai_scenes.py. Deliberately NOT ported: chat persistence
// (the SPA resends full history each request), the catalog/RAG context
// (_load_catalog_context), PostHog LLM analytics, and redis progress logs.
// The system prompts below are copied VERBATIM from ai_scene.py — keep them
// byte-identical when syncing changes.

export const SCENE_MODEL = "gpt-5.5";
export const CHAT_MODEL = "gpt-5.5";
export const SCENE_REVIEW_MODEL = "gpt-5.5";
// Python's AI_REQUEST_TIMEOUT is 600 seconds.
export const AI_REQUEST_TIMEOUT_MS = 600 * 1000;

export type JsonObject = Record<string, unknown>;
export type ChatHistoryItem = { role: string; content: string };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Port of openai_model(): a per-purpose model field wins, then the shared
// "model" field, then the hardcoded default.
export function openaiModel(
  settings: JsonObject,
  field: string,
  defaultModel: string,
): string {
  const configured = settings[field];
  const shared = settings["model"];
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  if (typeof shared === "string" && shared.trim()) {
    return shared.trim();
  }
  return defaultModel;
}

// Port of ai_scenes.py's _format_ai_exception.
export function formatAiException(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message.trim() || error.name
      : String(error).trim() || "Error";
  if (raw.toLowerCase() === "not found") {
    return (
      "OpenAI returned Not Found. Check the configured OpenAI model names in Settings -> OpenAI " +
      "(chat, scene generation, and review models) and make sure the API key has access to them."
    );
  }
  return raw;
}

function formatGpioButtons(gpioButtons: unknown[]): string[] {
  const formatted: string[] = [];
  for (const button of gpioButtons) {
    if (!button || typeof button !== "object" || Array.isArray(button)) {
      continue;
    }
    const entry = button as JsonObject;
    const label = String(entry.label ?? "").trim();
    const pin = entry.pin;
    let pinDisplay: string | null = null;
    if (typeof pin === "number" && Math.trunc(pin) > 0) {
      pinDisplay = String(Math.trunc(pin));
    } else if (typeof pin === "string" && /^\d+$/.test(pin.trim())) {
      pinDisplay = String(parseInt(pin.trim(), 10));
    }
    if (label && pinDisplay) {
      formatted.push(`${label} (pin ${pinDisplay})`);
    } else if (label) {
      formatted.push(label);
    } else if (pinDisplay) {
      formatted.push(`Pin ${pinDisplay}`);
    }
  }
  return formatted;
}

// Port of format_frame_context. The cloud passes what it knows (frames.name
// plus the hardware jsonb's width/height/device/color); fields the cloud
// does not have are simply absent and their lines are omitted.
export function formatFrameContext(frame: JsonObject | null | undefined): string | null {
  if (!frame) {
    return null;
  }
  const lines: string[] = [];
  const name = frame.name;
  if (typeof name === "string" && name.trim()) {
    lines.push(`- Frame name: ${name.trim()}`);
  }
  const width = frame.width;
  const height = frame.height;
  if (
    typeof width === "number" &&
    typeof height === "number" &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0
  ) {
    lines.push(`- Resolution: ${width}x${height}`);
  }
  const device = frame.device;
  if (typeof device === "string" && device.trim()) {
    lines.push(`- Device: ${device.trim()}`);
  }
  const color = frame.color;
  if (typeof color === "string" && color.trim()) {
    lines.push(`- Color mode: ${color.trim()}`);
  }
  const gpioButtons = frame.gpio_buttons ?? frame.gpioButtons ?? [];
  if (Array.isArray(gpioButtons) && gpioButtons.length > 0) {
    const formattedButtons = formatGpioButtons(gpioButtons);
    if (formattedButtons.length > 0) {
      lines.push(`- GPIO buttons: ${formattedButtons.join(", ")}.`);
      lines.push(
        "- To use a GPIO button, add an event node with data " +
          '{"keyword": "button", "label": "A"} (replace "A" with the button label), ' +
          "then follow with whatever you want (usually a logic/setAsState and a dispatch render).",
      );
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

// Port of format_frame_scene_summary. The self-hosted backend passes full
// scene JSON (nodes/edges/apps); the cloud only has assigned scene names, so
// the node/edge counts and app keywords are emitted only when a caller
// actually provides nodes/edges arrays.
export function formatFrameSceneSummary(
  scenes: JsonObject[] | null | undefined,
): string {
  if (!scenes || scenes.length === 0) {
    return "No scenes are installed on this frame yet.";
  }
  const lines: string[] = ["Installed scenes (short summary):"];
  for (const scene of scenes) {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      continue;
    }
    const sceneId = scene.id;
    const sceneName = scene.name || sceneId || "Untitled scene";
    let sceneLabel = `${sceneName}`;
    if (sceneId && sceneId !== sceneName) {
      sceneLabel = `${sceneName} (id: ${sceneId})`;
    }
    const nodes = scene.nodes;
    const edges = scene.edges;
    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
      // Cloud shape: names only.
      lines.push(`- ${sceneLabel}`);
      continue;
    }
    const appKeywords: string[] = [];
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        continue;
      }
      const entry = node as JsonObject;
      if (entry.type !== "app") {
        continue;
      }
      const data = (entry.data ?? {}) as JsonObject;
      const keyword = data.keyword;
      if (typeof keyword === "string" && !appKeywords.includes(keyword)) {
        appKeywords.push(keyword);
      }
    }
    let appsSummary = "";
    if (appKeywords.length > 0) {
      const preview = appKeywords.slice(0, 3).join(", ");
      const suffix = appKeywords.length > 3 ? "…" : "";
      appsSummary = ` Apps: ${preview}${suffix}.`;
    }
    lines.push(`- ${sceneLabel}: ${nodes.length} nodes, ${edges.length} edges.${appsSummary}`);
  }
  return lines.join("\n");
}

// Port of format_available_apps. The cloud has no server-side app config
// registry, so callers currently pass nothing and the block is omitted.
export function formatAvailableApps(apps: string[] | null | undefined): string | null {
  if (!apps || apps.length === 0) {
    return null;
  }
  const uniqueApps = Array.from(
    new Set(apps.filter((app) => typeof app === "string" && app.trim())),
  ).sort();
  if (uniqueApps.length === 0) {
    return null;
  }
  return "Available app keywords (authoritative): " + uniqueApps.join(", ");
}

function formatSelectedElements(
  selectedNodes: JsonObject[] | null | undefined,
  selectedEdges: JsonObject[] | null | undefined,
): string | null {
  const parts: string[] = [];
  if (selectedNodes && selectedNodes.length > 0) {
    parts.push(`Selected nodes: ${JSON.stringify(selectedNodes)}`);
  }
  if (selectedEdges && selectedEdges.length > 0) {
    parts.push(`Selected edges: ${JSON.stringify(selectedEdges)}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

// --- System prompts: VERBATIM copies from backend/app/utils/ai_scene.py ---

export const SCENE_JSON_SYSTEM_PROMPT = `
You are a FrameOS scene generator. Build scenes JSON that can be uploaded to FrameOS.
Reference TypeScript shapes (for structure sanity):
- Scene: { id: string, name: string, nodes: Node[], edges: Edge[], apps?: SceneApps, settings: { execution: "interpreted", ... }, fields?: Field[] }
- SceneApps: { [appKey: string]: SceneApp }; keys are scene-local app identifiers referenced by AppNodeData.keyword.
- SceneApp: { origin?: string, name?: string, category?: "data"|"logic"|"render", description?: string, version?: string|null, settings?: string[]|null, fields?: Field[], output?: { name: string, type: FieldType, example?: any }[], cache?: object|null, sources: AppSources }
- AppSources: { "config.json": string, "app.ts"?: string, "app.js"?: string, "app.tsx"?: string, "app.jsx"?: string, "app.nim"?: string, [filename: string]: string }
- Node: { id: string, type: "event"|"dispatch"|"app"|"state"|"code"|"scene", data: NodeData, position?: { x:number, y:number } }
- Edge: { id?: string, type?: "appNodeEdge"|"codeNodeEdge", source: string, target: string, sourceHandle?: string, targetHandle?: string }
- Field: { name: string, type: FieldType, label?: string, description?: string, required?: boolean, value?: any, options?: string[] }
- NodeData:
  - EventNodeData: { keyword: string }
  - DispatchNodeData: { keyword: string, config: object }
  - AppNodeData: { keyword: string, config: object, sources?: object, cache?: object }
  - StateNodeData: { keyword: string }
  - CodeNodeData: { codeJS?: string, code?: string, codeArgs?: { name: string, type: FieldType }[], codeOutputs?: { name: string, type: FieldType }[], cache?: object, logOutput?: boolean }
  - SceneNodeData: { keyword: string, config: object }
- FieldType: "string"|"text"|"float"|"integer"|"boolean"|"color"|"date"|"json"|"node"|"scene"|"image"|"font"|"select"|"path" (a "path" field is a string holding a file/folder path on the frame; it may carry pick?: "file"|"folder"|"any" and extensions?: string[])
Follow these rules:
- Output a JSON object with a top-level "title" string and "scenes" array. No markdown or code fences.
- Each scene must include: id (string), name (string), nodes (array), edges (array).
- Each scene must include settings.execution = "interpreted" (never "compiled").
- Each node must include: id (string), type (see below), data (object). Ignore positions.
- Supported node types: "event", "dispatch", "app", "state", "code", "scene".
- Edges can be of type "appNodeEdge" or "codeNodeEdge".
- Edges of type "appNodeEdge" connect app nodes (sourceHandle "next" to targetHandle "prev") or layout app fields (e.g. "field/render_functions[row][col]" to "prev").
- Edges of type "codeNodeEdge" connect code or state node outputs (sourceHandle "fieldOutput") to app or code node inputs (targetHandle "fieldInput/<fieldName>" or "codeField/<argName>").
- There is only one source handle for code/state outputs: "fieldOutput". Do NOT use "fieldOutput/<name>" or any named variants.
- Each scene starts from one event node with data.keyword = "render" to trigger rendering.
- Each connected render or logic node is executed in sequence via appNodeEdge edges.
- To trigger a re-render (for example after setting state), add a dispatch node with data.keyword = "render" and connect it in the appNodeEdge flow.
- Dispatch nodes are separate from apps; do not use app keywords like "dispatch/render".
- App nodes are generic. For the actual data to render, use code nodes or data apps connected via codeNodeEdge edges.
- If you want to render an image and then render text on top, use a render/image app node followed by a render/text app node,
  connecting them via appNodeEdge (next/prev), and connect the image data into the image app via codeNodeEdge.
- You can't have dangling specialized image rendering apps! E.g. do not use render/openaiImage alone; instead, ALWAYS connect its output into a
  render/image app, and connect the render/image app into the render flow.
- Logic apps (category "logic") can be used to process data; render apps (category "render") produce visual output.
- Data apps (category "data") provide data and must not be connected left/right in the render flow.
- Code nodes have only one output. The codeoutputs array must only contain one output, connected via "fieldOutput". The name is arbitrary and for reference only; do not encode it into the handle.
- Code nodes can include JavaScript, TypeScript, or JSX snippets in data.codeJS for interpreted scenes.
- Code nodes arguments are used as variables in the code snippet, just <argNamen> (no args. prefix).
- State nodes hold scene fields; set data.keyword to the field name. Use scene fields to allow user customization.
- Every state node must include data.value as a string default (use "" unless the prompt specifies a different default).
- Scene nodes embed other scenes; set data.keyword to the scene id.
- App node data must include data.keyword (app identifier) and data.config (app configuration).
- Data apps (e.g. "data/openaiText", "data/openaiImage") provide data via codeNodeEdge edges.
- Use ONLY app keywords from the provided context. If none match, use "render/text" and a simple message.
- Prefer minimal but valid configs; omit fields when not needed.
- Do not add node positions.
- Ensure number types match: connect floats to float fields and integers to integer fields; do not mix numeric types.
- When defining scene fields, set access = "public" and persist = "disk" unless there is a specific reason not to. This way users can modify them.
- Text apps can render rich text using the simple caret syntax (basic-caret) to display dynamic text.
  Use caret tokens like ^(16) for font size, ^(#FF00FF) for color, ^(PTSans-Bold.ttf) for font,
  ^(underline)/^(no-underline), ^(strikethrough)/^(no-strikethrough), combine styles via ^(16,#FF0000),
  and reset styles with ^(reset).
- State nodes are used to supply scene fields into code/app inputs: set data.keyword to the scene field name and connect
  them via codeNodeEdge with sourceHandle "fieldOutput" (no suffixes) to targetHandle "fieldInput/<fieldName>" or "codeField/<argName>".
- When multiple apps use the same state field, duplicate the state node for each app to keep routing clearer in the diagram.
- Create edges that link the nodes into a valid flow:
  - Use "appNodeEdge" with sourceHandle "next" and targetHandle "prev" to connect the render event to the first app,
    and to connect each subsequent app node in order.
  - Do not connect multiple "next" edges to the same "prev" handle. The render flow must be a single linear chain
    where each app node connects to exactly one next node in sequence.
  - If two nodes are connected via prev/next, do not connect those same nodes via any other edge type.
  - Logic + render apps form the left/right render flow (prev/next). Data apps are not part of the left/right chain
    and should only connect up/down via field output -> field input edges.
  - Apps in the render flow may still receive field inputs or emit field outputs; field wiring does NOT disqualify an
    app from being in the prev/next chain.
  - Only apps with category "logic" or "render" can be connected left/right using appNodeEdge. Apps with category
    "data" must not be connected left/right and must only connect via field outputs into inputs.
  - When an app outputs data into another app's input (e.g. data app into render/image), add a "codeNodeEdge" from
    sourceHandle "fieldOutput" to targetHandle "fieldInput/<fieldName>".
  - Every app node must be connected either through the render flow (prev/next) or via a field output/input edge.
- Data apps (including image apps) are up/down data providers and should NOT be chained into the render flow using
    "appNodeEdge". Instead, connect the render event directly to the render app (e.g. "render/image") with
    "appNodeEdge" and separately connect the data app output via "codeNodeEdge". This keeps the render flow triggered
    by the event.
  - Render/logic apps connected via prev/next always share the implicit context.image canvas. Do not pass the canvas
    through inputs when the app is in the prev/next chain.
  - If render apps are connected via field outputs instead of prev/next, the image data must be passed along (or
    generated) via field outputs/inputs as required.
  - Images are data. To display an image, first add a render app like "render/image" in the render flow, then connect
    the actual image output into its image field via a "codeNodeEdge" (fieldOutput -> fieldInput/imageField).
  - Never store an image output node as state in JSON; pass image outputs directly into app inputs via codeNodeEdge.
  - If you include an OpenAI image app (keyword "data/openaiImage"), do not set scene refreshInterval below 3600 unless
    the user explicitly asks for a faster update cadence.
- If you include a "code" node, connect its outputs to app inputs using "codeNodeEdge" with targetHandle
  "fieldInput/<fieldName>".
- If you include scene fields, add matching "state" nodes with data.keyword = field name, and connect them via
  "codeNodeEdge" to "code" nodes using targetHandle "codeField/<argName>" or directly to app inputs using
  "fieldInput/<fieldName>".
- Code nodes can be added anywhere for most fields (see "Haiku of the hour" for an example); only data.codeJS
  needs to be filled in for interpreted scenes.
- If you must use template strings, use code nodes with backticks. Do not use template strings directly in app configs.
- If you include "scene" nodes (to embed another scene), set data.keyword to the referenced scene id and connect them
  from a layout app (like "render/split") using "appNodeEdge" with sourceHandle
  "field/render_functions[row][col]" and targetHandle "prev".
- If you want to reduce the opacity of an image, render the image as a data node, then connect it to the "render/opacity"
  app as "image" and "opacity", and connect that to the "render/image" app in the render flow.
- If you render a "render/color" or "render/gradient" background, you will wipe out all that was there before.
- For render/text nodes, if there's no text to render (no value, no code node), omit the node.
- Scene settings:
  - settings.refreshInterval is the render cadence in seconds. Use it to control how often the scene re-renders.
    If a user mentions a render timeout or cadence, set refreshInterval accordingly (do not invent new timeout fields).
  - settings.backgroundColor sets the default scene background fill as a hex color (e.g. "#000000").
    If not specified, it defaults to black. Use render/color or render/gradient apps for more complex backgrounds.
    Setting backgroundColor ensures the scene starts rendering with that background; do not add a separate blank-screen step.
- For complex scenes, split data gathering from data rendering. Use data/logic apps or code nodes to gather/compute data,
  then persist JSON-friendly outputs (scalars, strings, objects, arrays) with the "logic/setAsState" app by wiring the
  output into fieldInput/valueJson. Later, read them back by referencing "state.<name>" via state nodes (keyword = name).
- Fonts available (TTF filenames) for font fields and caret syntax:
  - Ubuntu: Ubuntu-Regular.ttf (default), Ubuntu-Bold.ttf, Ubuntu-Italic.ttf, Ubuntu-BoldItalic.ttf,
    Ubuntu-Light.ttf, Ubuntu-LightItalic.ttf, Ubuntu-Medium.ttf, Ubuntu-MediumItalic.ttf.
  - PTSans: PTSans-Regular.ttf, PTSans-Bold.ttf, PTSans-Italic.ttf, PTSans-BoldItalic.ttf.
  - FiraGO: FiraGO-Regular.ttf, FiraGO-Italic.ttf, FiraGO-Bold.ttf, FiraGO-BoldItalic.ttf,
    FiraGO-Medium.ttf, FiraGO-MediumItalic.ttf, FiraGO-Light.ttf, FiraGO-LightItalic.ttf,
    FiraGO-ExtraLight.ttf, FiraGO-ExtraLightItalic.ttf, FiraGO-SemiBold.ttf, FiraGO-SemiBoldItalic.ttf,
    FiraGO-ExtraBold.ttf, FiraGO-ExtraBoldItalic.ttf, FiraGO-Heavy.ttf, FiraGO-HeavyItalic.ttf,
    FiraGO-Book.ttf, FiraGO-BookItalic.ttf, FiraGO-Thin.ttf, FiraGO-ThinItalic.ttf.
  - CormorantGaramond: Regular/Bold/Italic/BoldItalic/Light/LightItalic/Medium/MediumItalic/SemiBold/SemiBoldItalic.
  - Liberation: LiberationSans-Regular.ttf/Bold.ttf/Italic.ttf/BoldItalic.ttf,
    LiberationSerif-Regular.ttf/Bold.ttf/Italic.ttf/BoldItalic.ttf,
    LiberationMono-Regular.ttf/Bold.ttf/Italic.ttf/BoldItalic.ttf.
  - Other: CascadiaMono.ttf, CascadiaMonoItalic.ttf, ComicRelief.ttf, ComicRelief-Bold.ttf,
    Galindo-Regular.ttf, Peralta-Regular.ttf.
  - Users may upload custom fonts; if a requested font is unavailable, choose the closest available font or make it
    a scene field so it can be swapped later.
- Cache config can be applied to app or code nodes via data.cache with:
  - enabled: true to turn caching on.
  - inputEnabled: cache by inputs (output recalculates when any inputs change).
  - durationEnabled + duration (seconds): refresh after a fixed interval.
  - You can combine inputEnabled with an expression or duration to cache per inputs but still refresh on a schedule,
    e.g. cache by inputs and use an expression for the current date so it reloads once per day.
  - Alternatively, add a code node that outputs a date string and feed it into the app as an input; with inputEnabled
    the cache key changes daily because the date input changes.
- Every edge must reference nodes that exist in the "nodes" list. Do not include dangling edges.
- Every state field must include a default value in the "value" field as a String(val) version of itself. No quotes around strings.
- Interpreted scenes can include quick JavaScript, TypeScript, or JSX snippets in code nodes:
  - Put the snippet in data.codeJS (not data.code) for interpreted scenes.
  - The QuickJS environment exposes: state.<field>, <argName>, context.<event|payload|loopIndex|loopKey|hasImage>.
  - Console logging is available via console.log/warn/error.
  - Time helpers: parseTs(format, text), format(timestamp, format), now().
  - Keep snippets as expressions that return a value (e.g. "state.title ?? 'Hello'" or "url").
  - If you need multiple statements or setup logic, wrap the snippet in an IIFE and return the value.
  - Interpreted code nodes do not support image outputs. All other types (json, string, boolean, font, etc) are supported.
  - To use SVGs, route them through the download image app and pass a data URL into it.

Use any relevant scene examples from the provided context as guidance.
`.trim();

export const SCENE_CHAT_ROUTER_SYSTEM_PROMPT = `
You are a router that decides how to handle a FrameOS scene chat request.
Choose exactly one tool:
- build_scene: The user wants a new scene generated.
- modify_scene: The user wants edits to the current scene JSON.
- answer_frame_question: The user is asking about the frame, FrameOS, or how things work.
- answer_scene_question: The user is asking about the current scene, how it works, or how to edit it.
- reply: The user is chatting without needing tools.
Return JSON only with:
- tool: one of "build_scene", "modify_scene", "answer_frame_question", "answer_scene_question", "reply"
- tool_prompt: a concise prompt for the chosen tool (or the original user request if no rewrite is needed)
Rules:
- If there is no current scene provided, avoid "modify_scene".
- If there is no current scene provided, do not use "answer_scene_question".
- Use "build_scene" when the user asks to create something new or add a new scene.
- Use "modify_scene" when the user asks to change "this scene", "the current scene", or references an existing scene.
- Use "answer_scene_question" for explanations, diagnostics, or how-to questions about the current scene.
- Use "answer_frame_question" for frame-level questions (device settings, installed scenes, how FrameOS works).
`.trim();

export const SCENE_MODIFY_SYSTEM_PROMPT =
  SCENE_JSON_SYSTEM_PROMPT +
  "\n\n" +
  `
You are modifying an existing FrameOS scene. You will receive the current scene JSON and a user request.
Return updated JSON with a top-level "title" and "scenes" array.
Keep the scene id and name unless the user explicitly asks to change them.
Only adjust what the user requested; preserve existing structure when possible.
You will be given an authoritative list of available app keywords. Use only those app keywords; do not invent new apps.
`.trim();

export const FRAME_CHAT_ANSWER_SYSTEM_PROMPT = `
You are a friendly assistant for FrameOS frames.
Answer questions about the frame or FrameOS itself.
Use the provided context (frame details, installed scene summary, and reference context).

High-level FrameOS facts you can use:
- FrameOS is an operating system for single-function smart frames built for Raspberry Pi-class hardware.
- It supports both e-ink and traditional displays, including very low refresh (seconds per frame) and high refresh
  (up to 60fps) screens, with example use cases like calendars, meeting room displays, dashboards, signage, and
  interactive message boards.
- Frames run a compiled on-device runtime (written in Nim) and operate locally; there is no required cloud
  subscription. The backend is used to configure, deploy, and manage frames over SSH.
- The backend can run locally or on a server, is available as a Docker app (and Home Assistant addon), and serves a
  web UI for creating and deploying scenes.
- Users can deploy prebuilt scenes or create their own in the scene editor; scenes are made of apps/nodes wired
  together for data and rendering.
- Common hardware includes Raspberry Pi + e-ink HATs (Waveshare/Pimoroni) or HDMI displays; Raspberry Pi OS Lite is a
  typical base OS.

Provide helpful context without overwhelming the user; keep replies short unless they ask for specifics.
Limit answers to a few short paragraphs (2-3 max) and avoid long lists unless the user asks.
Invite follow-up questions and make it clear they can ask about other scenes too.
If the answer is uncertain, say what is missing and how to proceed.
Return JSON only with the key "answer".
`.trim();

export const SCENE_CHAT_ANSWER_SYSTEM_PROMPT = `
You are a friendly assistant for FrameOS scenes.
Answer questions about the current scene or how to edit it.
Use the provided context (scene JSON, selected nodes/edges, frame details, and reference context).
Provide helpful context without overwhelming the user; keep replies short unless they ask for specifics.
Limit answers to a few short paragraphs (2-3 max) and avoid long lists unless the user asks.
If the answer is uncertain, say what is missing and how to proceed.
Return JSON only with the key "answer".
`.trim();

export const SCENE_PLAN_SYSTEM_PROMPT = `
You are planning a FrameOS scene. Produce a concise plan that will be compiled into scene JSON later.
If the app is so complex that it requires processed input data to be read multiple times, store the processed output in
a private state field with the "logic/setAsState" app, then read it back via state nodes later.
Return JSON with keys:
- title: optional string for the scene.
- intent: short statement of what the user wants.
- components: array of app keywords or scene concepts to include.
- layout: short description of layout/placement strategy.
- data_flow: short description of how data flows into render/logic apps.
- open_questions: array of strings for missing info; leave empty if not needed.
Do not include markdown or code fences.
`.trim();

export const SCENE_REVIEW_SYSTEM_PROMPT = `
You are a strict reviewer for FrameOS scene JSON.
Check the scene against the user request and ensure it is valid:
- It has a top-level "scenes" array with at least one scene.
- Each scene has id, name, nodes, edges, and settings.execution = "interpreted".
- There is at least one event node with data.keyword = "render".
- Every edge references existing node ids for source and target.
- Logic apps should be connected via prev/next or field output/input edges. Data apps (keywords starting with "data/") do
  NOT need to be in the prev/next render chain and should not be flagged for that; they are executed via data edges.
- Code nodes and state nodes are NOT part of the prev/next render chain; do not require or suggest they be connected via
  appNodeEdge. They should only connect via codeNodeEdge edges.
- Apps (including render apps) may be in the prev/next render flow and also receive field inputs or emit field outputs.
- Code/state output handles must be exactly "fieldOutput". Do not require or suggest named handles like "fieldOutput/<name>".
- All state fields include a default "value" field which is a string.
- Duplicate state nodes that reference the same field keyword are allowed (they may be duplicated for clarity in routing).
- The render flow does not branch: no multiple "next" edges point to the same "prev" handle.
- If two nodes are connected via prev/next, they should not also be connected by any other edge type.
- No image output is stored as state in JSON; image outputs must be wired directly into app inputs.
- FrameOS scenes always render a visual output. The render event sets up context.image. Apps connected via prev/next operate
  on that shared canvas without needing it passed through inputs.
- Frame details (frame name, resolution, device, GPIO buttons) are optional context hints. Do NOT require them to be encoded
  in the scene unless the user explicitly asked to reference them.
- Do not require render app configs to include resolution or size metadata unless the user explicitly asked for it.
- GPIO buttons are optional hardware hints. Only require button events or button-driven logic if the user explicitly asked for
  a GPIO button interaction.
- Be pragmatic about user-request matching: only flag clear contradictions or missing must-have elements. Do not be overly critical
  about stylistic differences or exact phrasing.
- Do not suggest or imply changing the scene title during review. Title changes are not part of review feedback.
Respond with JSON only, using keys:
- solves: boolean (true only if the scene matches the user request)
- issues: array of short strings describing any problems
`.trim();

// --- OpenAI call plumbing ---

// Mirrors the Python AsyncOpenAI usage: POST /v1/chat/completions with
// response_format json_object and a 600 s timeout, no SDK dependency.
async function requestChatCompletion({
  apiKey,
  model,
  messages,
}: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
}): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    body: JSON.stringify({
      messages,
      model,
      response_format: { type: "json_object" },
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    let detail = `OpenAI request failed with status ${response.status}`;
    try {
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      if (payload?.error?.message) {
        detail = payload.error.message;
      }
    } catch {
      // keep the status-based message
    }
    if (response.status === 404 && detail === `OpenAI request failed with status 404`) {
      detail = "Not found";
    }
    throw new Error(detail);
  }
  const payload = (await response.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  return payload.choices?.[0]?.message?.content ?? "{}";
}

async function requestJsonObject(args: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
}): Promise<JsonObject> {
  const content = await requestChatCompletion(args);
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as JsonObject;
}

// Port of _format_reference_context. With the catalog dropped this is always
// empty; kept as a hook so a future catalog port slots back in.
function formatReferenceContext(catalogContext?: string | null): string {
  return catalogContext ?? "";
}

function historyMessages(history: ChatHistoryItem[] | null | undefined): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of history ?? []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const { role, content } = item;
    if (
      (role === "user" || role === "assistant") &&
      typeof content === "string" &&
      content.trim()
    ) {
      messages.push({ content: content.trim(), role });
    }
  }
  return messages;
}

// --- Ported OpenAI-backed operations ---

export async function routeSceneChat({
  prompt,
  apiKey,
  scene,
  frameContext,
  history,
  model,
}: {
  prompt: string;
  apiKey: string;
  scene?: JsonObject | null;
  frameContext?: string | null;
  history?: ChatHistoryItem[] | null;
  model: string;
}): Promise<JsonObject> {
  const promptParts = [`User request: ${prompt}`];
  if (frameContext) {
    promptParts.push("Frame details:", frameContext);
  }
  if (scene) {
    promptParts.push("Current scene JSON:", JSON.stringify(scene));
  }
  if (history && history.length > 0) {
    const historyLines = history
      .filter((item) => item && item.role && item.content)
      .map((item) => `${item.role}: ${item.content}`);
    if (historyLines.length > 0) {
      promptParts.push("Recent chat history:", historyLines.join("\n"));
    }
  }
  return await requestJsonObject({
    apiKey,
    messages: [
      { content: SCENE_CHAT_ROUTER_SYSTEM_PROMPT, role: "system" },
      { content: promptParts.join("\n\n"), role: "user" },
    ],
    model: model || CHAT_MODEL,
  });
}

export async function generateScenePlan({
  prompt,
  apiKey,
  model,
  frameContext,
  catalogContext,
}: {
  prompt: string;
  apiKey: string;
  model: string;
  frameContext?: string | null;
  catalogContext?: string | null;
}): Promise<JsonObject> {
  const contextBlock = formatReferenceContext(catalogContext);
  const planPromptParts = [`User request: ${prompt}`];
  if (frameContext) {
    planPromptParts.push("Frame details:", frameContext);
  }
  planPromptParts.push("Relevant context:", contextBlock || "(no context available)");
  return await requestJsonObject({
    apiKey,
    messages: [
      { content: SCENE_PLAN_SYSTEM_PROMPT, role: "system" },
      { content: planPromptParts.join("\n\n"), role: "user" },
    ],
    model: model || SCENE_MODEL,
  });
}

export async function generateSceneJson({
  prompt,
  apiKey,
  model,
  plan,
  frameContext,
  catalogContext,
}: {
  prompt: string;
  apiKey: string;
  model: string;
  plan?: JsonObject | null;
  frameContext?: string | null;
  catalogContext?: string | null;
}): Promise<JsonObject> {
  const contextBlock = formatReferenceContext(catalogContext);
  const scenePromptParts = [`User request: ${prompt}`];
  if (plan && Object.keys(plan).length > 0) {
    scenePromptParts.push(`Scene plan: ${JSON.stringify(plan)}`);
  }
  scenePromptParts.push("Relevant context:", contextBlock || "(no context available)");
  return await requestJsonObject({
    apiKey,
    messages: [
      {
        content: SCENE_JSON_SYSTEM_PROMPT + (frameContext ? "\n\n" + frameContext : ""),
        role: "system",
      },
      { content: scenePromptParts.join("\n\n"), role: "user" },
    ],
    model: model || SCENE_MODEL,
  });
}

// Note: like the Python original, the broken payload itself is NOT sent to
// the model — only the user request, the reviewer issues, and the plan.
export async function repairSceneJson({
  prompt,
  apiKey,
  model,
  issues,
  plan,
  frameContext,
  catalogContext,
}: {
  prompt: string;
  apiKey: string;
  model: string;
  issues: string[];
  plan?: JsonObject | null;
  frameContext?: string | null;
  catalogContext?: string | null;
}): Promise<JsonObject> {
  const contextBlock = formatReferenceContext(catalogContext);
  const scenePromptParts = [
    `User request: ${prompt}`,
    `Reviewer issues: ${JSON.stringify(issues)}`,
  ];
  if (plan && Object.keys(plan).length > 0) {
    scenePromptParts.push(`Scene plan: ${JSON.stringify(plan)}`);
  }
  if (frameContext) {
    scenePromptParts.push("Frame details:", frameContext);
  }
  scenePromptParts.push("Relevant context:", contextBlock || "(no context available)");
  return await requestJsonObject({
    apiKey,
    messages: [
      { content: SCENE_JSON_SYSTEM_PROMPT, role: "system" },
      { content: scenePromptParts.join("\n\n"), role: "user" },
    ],
    model: model || SCENE_MODEL,
  });
}

export async function modifySceneJson({
  prompt,
  scene,
  apiKey,
  model,
  availableApps,
  issues,
  frameContext,
  selectedNodes,
  selectedEdges,
  catalogContext,
}: {
  prompt: string;
  scene: JsonObject;
  apiKey: string;
  model: string;
  availableApps?: string[] | null;
  issues?: string[] | null;
  frameContext?: string | null;
  selectedNodes?: JsonObject[] | null;
  selectedEdges?: JsonObject[] | null;
  catalogContext?: string | null;
}): Promise<JsonObject> {
  const contextBlock = formatReferenceContext(catalogContext);
  const promptParts = [
    `User request: ${prompt}`,
    "Current scene JSON:",
    JSON.stringify(scene),
  ];
  const availableAppsBlock = formatAvailableApps(availableApps);
  if (availableAppsBlock) {
    promptParts.push(availableAppsBlock);
  }
  const selectedContext = formatSelectedElements(selectedNodes, selectedEdges);
  if (selectedContext) {
    promptParts.push("User selection in editor:", selectedContext);
  }
  if (issues && issues.length > 0) {
    promptParts.push(`Known issues: ${JSON.stringify(issues)}`);
  }
  if (frameContext) {
    promptParts.push("Frame details:", frameContext);
  }
  promptParts.push("Relevant context:", contextBlock || "(no context available)");
  return await requestJsonObject({
    apiKey,
    messages: [
      {
        content: SCENE_MODIFY_SYSTEM_PROMPT + (frameContext ? "\n\n" + frameContext : ""),
        role: "system",
      },
      { content: promptParts.join("\n\n"), role: "user" },
    ],
    model: model || SCENE_MODEL,
  });
}

export async function answerSceneQuestion({
  prompt,
  apiKey,
  model,
  frameContext,
  scene,
  selectedNodes,
  selectedEdges,
  history,
  catalogContext,
}: {
  prompt: string;
  apiKey: string;
  model: string;
  frameContext?: string | null;
  scene?: JsonObject | null;
  selectedNodes?: JsonObject[] | null;
  selectedEdges?: JsonObject[] | null;
  history?: ChatHistoryItem[] | null;
  catalogContext?: string | null;
}): Promise<string> {
  const contextBlock = formatReferenceContext(catalogContext);
  const contextParts: string[] = [];
  if (frameContext) {
    contextParts.push("Frame details:", frameContext);
  }
  if (scene) {
    contextParts.push("Current scene JSON:", JSON.stringify(scene));
  }
  const selectedContext = formatSelectedElements(selectedNodes, selectedEdges);
  if (selectedContext) {
    contextParts.push("User selection in editor:", selectedContext);
  }
  if (contextBlock) {
    contextParts.push("Relevant reference context:", contextBlock);
  }
  const contextMessage =
    contextParts.length > 0 ? contextParts.join("\n\n") : "No additional context.";
  const messages: ChatMessage[] = [
    { content: SCENE_CHAT_ANSWER_SYSTEM_PROMPT, role: "system" },
    { content: contextMessage, role: "user" },
    ...historyMessages(history),
    { content: prompt, role: "user" },
  ];
  const content = await requestChatCompletion({
    apiKey,
    messages,
    model: model || CHAT_MODEL,
  });
  return extractAnswer(content);
}

export async function answerFrameQuestion({
  prompt,
  apiKey,
  model,
  frameContext,
  frameSceneSummary,
  history,
  catalogContext,
}: {
  prompt: string;
  apiKey: string;
  model: string;
  frameContext?: string | null;
  frameSceneSummary?: string | null;
  history?: ChatHistoryItem[] | null;
  catalogContext?: string | null;
}): Promise<string> {
  const contextBlock = formatReferenceContext(catalogContext);
  const contextParts: string[] = [];
  if (frameContext) {
    contextParts.push("Frame details:", frameContext);
  }
  if (frameSceneSummary) {
    contextParts.push("Installed scenes:", frameSceneSummary);
  }
  if (contextBlock) {
    contextParts.push("Relevant reference context:", contextBlock);
  }
  const contextMessage =
    contextParts.length > 0 ? contextParts.join("\n\n") : "No additional context.";
  const messages: ChatMessage[] = [
    { content: FRAME_CHAT_ANSWER_SYSTEM_PROMPT, role: "system" },
    { content: contextMessage, role: "user" },
    ...historyMessages(history),
    { content: prompt, role: "user" },
  ];
  const content = await requestChatCompletion({
    apiKey,
    messages,
    model: model || CHAT_MODEL,
  });
  return extractAnswer(content);
}

function extractAnswer(content: string): string {
  try {
    const payload = JSON.parse(content) as unknown;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const answer = (payload as JsonObject).answer;
      if (typeof answer === "string" && answer.trim()) {
        return answer.trim();
      }
    }
  } catch {
    // fall through to the raw content
  }
  return content.trim();
}

export async function reviewSceneSolution({
  prompt,
  payload,
  apiKey,
  model,
  frameContext,
}: {
  prompt: string;
  payload: JsonObject;
  apiKey: string;
  model: string;
  frameContext?: string | null;
}): Promise<string[]> {
  const reviewPromptParts = [`User request: ${prompt}`];
  if (frameContext) {
    reviewPromptParts.push("Frame details:", frameContext);
  }
  reviewPromptParts.push("Scene JSON:", JSON.stringify(payload));
  const response = await requestJsonObject({
    apiKey,
    messages: [
      { content: SCENE_REVIEW_SYSTEM_PROMPT, role: "system" },
      { content: reviewPromptParts.join("\n\n"), role: "user" },
    ],
    model: model || SCENE_REVIEW_MODEL,
  });
  const solves = response.solves;
  const issues = response.issues;
  if (solves === true) {
    return [];
  }
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.map((issue) => String(issue));
  }
  return ["Scene review did not confirm the response solves the request."];
}

// --- Pure helpers (ported, unit-tested) ---

// Port of validate_scene_payload from ai_scene.py.
export function validateScenePayload(payload: JsonObject): string[] {
  const issues: string[] = [];
  const scenes = payload.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return ["Scene payload must include a non-empty scenes array."];
  }
  scenes.forEach((scene, index) => {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      issues.push(`Scene ${index} is not an object.`);
      return;
    }
    const entry = scene as JsonObject;
    const sceneId = entry.id;
    const sceneName = entry.name;
    const nodes = entry.nodes;
    const edges = entry.edges;
    const settings = (entry.settings ?? {}) as JsonObject;
    if (!sceneId || !sceneName) {
      issues.push(`Scene ${index} is missing id or name.`);
    }
    if (!Array.isArray(nodes) || nodes.length === 0) {
      issues.push(`Scene ${index} must include nodes.`);
      return;
    }
    if (!Array.isArray(edges)) {
      issues.push(`Scene ${index} must include edges.`);
      return;
    }
    if (settings.execution !== "interpreted") {
      issues.push(`Scene ${index} settings.execution must be 'interpreted'.`);
    }
    const nodeIds = new Set<string>();
    let renderEventFound = false;
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        continue;
      }
      const nodeEntry = node as JsonObject;
      const nodeId = nodeEntry.id;
      if (typeof nodeId === "string") {
        if (nodeIds.has(nodeId)) {
          issues.push(`Scene ${index} has duplicate node id ${nodeId}.`);
        }
        nodeIds.add(nodeId);
      }
      const nodeType = nodeEntry.type;
      const data = (nodeEntry.data ?? {}) as JsonObject;
      if (nodeType === "event" && data.keyword === "render") {
        renderEventFound = true;
      }
    }
    if (!renderEventFound) {
      issues.push(`Scene ${index} is missing a render event node.`);
    }
    for (const edge of edges) {
      if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
        issues.push(`Scene ${index} has an edge that is not an object.`);
        continue;
      }
      const edgeEntry = edge as JsonObject;
      const source = edgeEntry.source;
      const target = edgeEntry.target;
      if (typeof source !== "string" || !nodeIds.has(source)) {
        issues.push(`Scene ${index} edge source '${source}' is not a valid node id.`);
      }
      if (typeof target !== "string" || !nodeIds.has(target)) {
        issues.push(`Scene ${index} edge target '${target}' is not a valid node id.`);
      }
    }
  });
  return issues;
}

// Port of ai_scenes.py's _split_state_nodes_by_app: when one state node
// feeds several app nodes, clone it per app so the diagram routing stays
// legible. Mutates the payload in place, like the Python.
export function splitStateNodesByApp(payload: JsonObject): void {
  const scenes = payload.scenes;
  if (!Array.isArray(scenes)) {
    return;
  }

  for (const scene of scenes) {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      continue;
    }
    const sceneEntry = scene as JsonObject;
    let nodes = sceneEntry.nodes;
    const edges = sceneEntry.edges;
    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
      continue;
    }

    const nodeById = new Map<string, JsonObject>();
    for (const node of nodes) {
      if (node && typeof node === "object" && !Array.isArray(node)) {
        const entry = node as JsonObject;
        if (typeof entry.id === "string") {
          nodeById.set(entry.id, entry);
        }
      }
    }
    const appIds = new Set<string>();
    const stateIds = new Set<string>();
    for (const [nodeId, node] of nodeById) {
      if (node.type === "app") {
        appIds.add(nodeId);
      } else if (node.type === "state") {
        stateIds.add(nodeId);
      }
    }
    if (appIds.size === 0 || stateIds.size === 0) {
      continue;
    }

    const edgesByState = new Map<string, Map<string, JsonObject[]>>();
    for (const edge of edges) {
      if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
        continue;
      }
      const edgeEntry = edge as JsonObject;
      const source = edgeEntry.source;
      const target = edgeEntry.target;
      if (
        typeof source === "string" &&
        typeof target === "string" &&
        stateIds.has(source) &&
        appIds.has(target)
      ) {
        let byApp = edgesByState.get(source);
        if (!byApp) {
          byApp = new Map();
          edgesByState.set(source, byApp);
        }
        const list = byApp.get(target);
        if (list) {
          list.push(edgeEntry);
        } else {
          byApp.set(target, [edgeEntry]);
        }
      }
    }

    if (edgesByState.size === 0) {
      continue;
    }

    const newNodes: JsonObject[] = [];
    const nodesToRemove = new Set<string>();
    for (const [stateId, appEdges] of edgesByState) {
      if (appEdges.size <= 1) {
        continue;
      }
      const stateNode = nodeById.get(stateId);
      if (!stateNode) {
        continue;
      }
      for (const appEdgeList of appEdges.values()) {
        const newId = crypto.randomUUID();
        const newNode = structuredClone(stateNode);
        newNode.id = newId;
        newNodes.push(newNode);
        for (const edge of appEdgeList) {
          edge.source = newId;
        }
      }
      nodesToRemove.add(stateId);
    }

    if (nodesToRemove.size > 0) {
      for (const stateId of Array.from(nodesToRemove)) {
        const stillReferenced = edges.some(
          (edge) =>
            edge &&
            typeof edge === "object" &&
            !Array.isArray(edge) &&
            (edge as JsonObject).source === stateId,
        );
        if (stillReferenced) {
          nodesToRemove.delete(stateId);
        }
      }
      if (nodesToRemove.size > 0) {
        nodes = nodes.filter(
          (node) =>
            !(
              node &&
              typeof node === "object" &&
              !Array.isArray(node) &&
              typeof (node as JsonObject).id === "string" &&
              nodesToRemove.has((node as JsonObject).id as string)
            ),
        );
        sceneEntry.nodes = nodes;
      }
    }

    if (newNodes.length > 0) {
      if (!Array.isArray(sceneEntry.nodes)) {
        sceneEntry.nodes = [];
      }
      (sceneEntry.nodes as unknown[]).push(...newNodes);
    }
  }
}

export const SCENE_CHAT_TOOLS = new Set([
  "build_scene",
  "modify_scene",
  "answer_frame_question",
  "answer_scene_question",
  "reply",
]);

// Tool-name normalization from chat_scene: unknown tools fall back to
// answer_frame_question, and scene-scoped tools degrade to it when no scene
// was provided.
export function normalizeSceneChatTool(tool: unknown, hasScene: boolean): string {
  let normalized =
    typeof tool === "string" && SCENE_CHAT_TOOLS.has(tool)
      ? tool
      : "answer_frame_question";
  if (normalized === "modify_scene" && !hasScene) {
    normalized = "answer_frame_question";
  }
  if (normalized === "answer_scene_question" && !hasScene) {
    normalized = "answer_frame_question";
  }
  return normalized;
}

// Stamp the originating prompt into each scene's settings, as chat_scene
// does after build/modify.
export function stampScenePrompt(scenes: unknown[], prompt: string): void {
  for (const scene of scenes) {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      continue;
    }
    const entry = scene as JsonObject;
    let settings = entry.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      settings = {};
      entry.settings = settings;
    }
    (settings as JsonObject).prompt = prompt;
  }
}
