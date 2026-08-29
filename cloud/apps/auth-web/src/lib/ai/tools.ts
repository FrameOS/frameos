// Tool definitions + executor for the AI chat agent loop. Tools fall into
// five groups: knowledge (bundled catalog/docs), source code (GitHub raw,
// Nim excluded), frames (Postgres telemetry + command queue), store catalog
// (public scenes plus everything the user owns or has installed on a
// frame), and scene delivery (create/update with local validation — invalid
// JSON bounces back to the model as tool output instead of reaching the
// editor).
import { and, desc, eq, exists, gt, isNull, or } from "drizzle-orm";
import {
  accounts,
  createDb,
  frames,
  frameLogs,
  frameMetrics,
  frameSceneAssignments,
  storeScenes,
  storeSceneVersions,
} from "@frameos-cloud/db";
import {
  appCatalog,
  getApp,
  getExample,
  knownAppKeywords,
  readDoc,
  searchApps,
  searchDocs,
  searchExamples,
} from "./context";
import {
  bundleRepoApps,
  splitStateNodesByApp,
  validateAppKeywords,
  validateScenePayload,
  type JsonObject,
} from "./scene-utils";
import type { ResponsesToolDefinition } from "./openai";
import { formatLintIssues, lintScenes, type LintIssue } from "./scene-lint";
import {
  assignScenesToFrame,
  currentSceneAssignments,
  maxScenesPerFrame,
} from "../frame-scenes";
import {
  enqueueFrameCommand,
  frameForAccount,
  frameSummary,
  supersedePendingCommands,
} from "../frames";
import { createAccountScene } from "../account-scene-create";
import { forkStoreScene, sceneIdPattern } from "../store-fork";
import { readBlob } from "../blobs";
import { extractScenesFromZip } from "../scene-title";

export type ScenesEvent = {
  type: "scenes";
  tool: "build_scene" | "modify_scene";
  title?: string;
  scenes: unknown[];
};

export type ToolContext = {
  db: ReturnType<typeof createDb>;
  accountId: string;
  prompt: string;
  frameId?: string | null;
  currentScene?: JsonObject | null;
  currentSceneId?: string | null;
  emitScenes: (event: ScenesEvent) => void;
  // Set when a create_scenes/update_scene call validated and was delivered;
  // the loop reports it as the overall "tool" of the turn.
  deliveredTool?: "build_scene" | "modify_scene";
  // The scenes of the most recent successful delivery, so save_scene can save
  // "what you just made" without the model re-sending the whole JSON.
  deliveredScenes?: unknown[];
  // Audit actor for anything save_scene writes. Undefined only in tests.
  providerSubject?: string | undefined;
  // The store scene the user is viewing/editing (scenes.frameos.net). Makes
  // save_scene default to a fork of it, so lineage + preview image carry over.
  storeSceneId?: string | null;
  // Every scene currently open in the editor (multi-scene templates); used
  // to resolve scene-node references when linting.
  editorScenes?: unknown[] | null;
};

const MAX_TOOL_OUTPUT_CHARS = 60_000;
const MAX_LOG_LINES = 300;
const MAX_METRIC_SAMPLES = 100;

// --- GitHub source access (read-only, public repo, Nim excluded) ---

const REPO = process.env.FRAMEOS_AI_REPO ?? "FrameOS/frameos";
const REPO_REF = process.env.FRAMEOS_AI_REPO_REF ?? "main";
const REPO_PATH_PREFIXES = [
  "frontend/src/",
  "repo/",
  "docs/",
  "cloud/docs/",
  "e2e/scenes/",
];
const REPO_TREE_TTL_MS = 10 * 60 * 1000;
const MAX_REPO_FILE_CHARS = 60_000;

let repoTreeCache: { fetchedAt: number; paths: string[] } | null = null;

function repoPathAllowed(path: string): boolean {
  if (path.endsWith(".nim") || path.includes("..")) {
    return false;
  }
  return REPO_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "frameos-cloud-ai",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function repoTree(): Promise<string[]> {
  if (repoTreeCache && Date.now() - repoTreeCache.fetchedAt < REPO_TREE_TTL_MS) {
    return repoTreeCache.paths;
  }
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/git/trees/${REPO_REF}?recursive=1`,
    { headers: githubHeaders(), signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    throw new Error(`GitHub tree listing failed with status ${response.status}`);
  }
  const payload = (await response.json()) as {
    tree?: { path?: string; type?: string }[];
  };
  const paths = (payload.tree ?? [])
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => entry.path as string)
    .filter(repoPathAllowed);
  repoTreeCache = { fetchedAt: Date.now(), paths };
  return paths;
}

async function readRepoFile(path: string): Promise<string> {
  const response = await fetch(
    `https://raw.githubusercontent.com/${REPO}/${REPO_REF}/${path}`,
    { headers: { "User-Agent": "frameos-cloud-ai" }, signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    throw new Error(`Could not read ${path} (status ${response.status})`);
  }
  const text = await response.text();
  if (text.length > MAX_REPO_FILE_CHARS) {
    return `${text.slice(0, MAX_REPO_FILE_CHARS)}\n...(truncated at ${MAX_REPO_FILE_CHARS} chars)`;
  }
  return text;
}

// --- tool schemas ---

export const toolDefinitions: ResponsesToolDefinition[] = [
  {
    description:
      "Search the FrameOS app catalog by keyword, name or description. Returns compact matches; " +
      "use get_app for full field details before using an app in a scene.",
    name: "search_apps",
    parameters: {
      additionalProperties: false,
      properties: {
        category: {
          description: "Optional filter: data, logic, or render.",
          enum: ["data", "logic", "render"],
          type: "string",
        },
        query: { description: "Search terms. Omit to list every app.", type: "string" },
      },
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Full config of one app: fields (names, types, defaults), outputs, caching. For JS apps " +
      "(repo/apps/code/*) this includes the TypeScript source.",
    name: "get_app",
    parameters: {
      additionalProperties: false,
      properties: {
        keyword: { description: "App keyword, e.g. render/text or repo/apps/code/weatherPanel.", type: "string" },
      },
      required: ["keyword"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Search the bundled example scenes (official FrameOS templates). Returns name, slug, description " +
      "and which apps each uses. Great as blueprints for new scenes.",
    name: "search_examples",
    parameters: {
      additionalProperties: false,
      properties: {
        query: { description: "Search terms. Omit to list all examples.", type: "string" },
      },
      type: "object",
    },
    type: "function",
  },
  {
    description: "Full scene JSON of one example scene, by slug (e.g. samples/Weather).",
    name: "get_example",
    parameters: {
      additionalProperties: false,
      properties: {
        slug: { description: "Example slug from search_examples.", type: "string" },
      },
      required: ["slug"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Search the FrameOS documentation (architecture, cloud frames protocol, deployment, auth). " +
      "Returns matching sections with excerpts; use read_doc for full text.",
    name: "search_docs",
    parameters: {
      additionalProperties: false,
      properties: {
        query: { description: "Search terms.", type: "string" },
      },
      required: ["query"],
      type: "object",
    },
    type: "function",
  },
  {
    description: "Read a documentation file (optionally a single section by heading).",
    name: "read_doc",
    parameters: {
      additionalProperties: false,
      properties: {
        heading: { description: "Optional section heading from search_docs.", type: "string" },
        path: { description: "Doc path from search_docs, e.g. docs/cloud-frames.md.", type: "string" },
      },
      required: ["path"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "List source files of the FrameOS repository (frontend, example scenes, JS apps, docs). " +
      "Use to find code that answers a question, then read_repo_file.",
    name: "list_repo_files",
    parameters: {
      additionalProperties: false,
      properties: {
        prefix: {
          description: "Path prefix filter, e.g. frontend/src/scenes or repo/apps/code.",
          type: "string",
        },
        query: { description: "Optional substring to match in file paths.", type: "string" },
      },
      type: "object",
    },
    type: "function",
  },
  {
    description: "Read one source file from the FrameOS repository.",
    name: "read_repo_file",
    parameters: {
      additionalProperties: false,
      properties: {
        path: { description: "Repository-relative path from list_repo_files.", type: "string" },
      },
      required: ["path"],
      type: "object",
    },
    type: "function",
  },
  {
    description: "List the user's frames with connection status and basic hardware info.",
    name: "list_frames",
    parameters: { additionalProperties: false, properties: {}, type: "object" },
    type: "function",
  },
  {
    description:
      "Details of one frame: hardware, connectivity, assigned scenes, deploy state (assigned vs " +
      "device-acknowledged), latest reported state and metrics. Start here when debugging a frame.",
    name: "get_frame",
    parameters: {
      additionalProperties: false,
      properties: {
        frame_id: { description: "Frame id from list_frames.", type: "string" },
      },
      required: ["frame_id"],
      type: "object",
    },
    type: "function",
  },
  {
    description: "Recent device logs for a frame (newest last).",
    name: "get_frame_logs",
    parameters: {
      additionalProperties: false,
      properties: {
        frame_id: { description: "Frame id.", type: "string" },
        limit: { description: "Max lines (default 100, max 300).", type: "integer" },
      },
      required: ["frame_id"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Recent metrics samples for a frame (memory, load, uptime and similar, device-dependent), newest last.",
    name: "get_frame_metrics",
    parameters: {
      additionalProperties: false,
      properties: {
        frame_id: { description: "Frame id.", type: "string" },
        samples: { description: "Max samples (default 20, max 100).", type: "integer" },
      },
      required: ["frame_id"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Ask a connected frame to report fresh metrics now. Delivery is asynchronous: the sample lands in " +
      "get_frame_metrics a few seconds later.",
    name: "request_live_metrics",
    parameters: {
      additionalProperties: false,
      properties: {
        frame_id: { description: "Frame id.", type: "string" },
      },
      required: ["frame_id"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Install a store scene on a frame and deploy it. Adds the scene to the frame's assigned scenes and " +
      "immediately pushes the whole set to the device — this is exactly what the Scenes tab's Save/Deploy " +
      "button does, so do NOT tell the user to do it by hand. The change is live on the physical frame, so " +
      "only call this when the user asked for it. Use scene ids from search_store_scenes / get_store_scene " +
      "and frame ids from list_frames. Already-assigned scenes are re-deployed rather than duplicated. An " +
      "offline frame still accepts the call: the push is queued and lands when it reconnects.",
    name: "add_scene_to_frame",
    parameters: {
      additionalProperties: false,
      properties: {
        frame_id: { description: "Frame id.", type: "string" },
        scene_id: {
          description: "Store scene id to install.",
          type: "string",
        },
        scene_version: {
          description:
            "Pin this published version. Omit to track the latest version.",
          type: "integer",
        },
      },
      required: ["frame_id", "scene_id"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Search store scenes: every public scene plus ALL of the user's own scenes (private ones included). " +
      "Returns name, slug, description, category, tags, download counts, visibility and whether the " +
      "publisher is verified. Check here before saying a scene does not exist.",
    name: "search_store_scenes",
    parameters: {
      additionalProperties: false,
      properties: {
        query: { description: "Search terms. Omit to list the catalog.", type: "string" },
      },
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Full scene JSON of a store scene (public scenes, any scene the user owns, or any scene installed " +
      "on one of their frames). Use before recommending, forking or modifying a store scene.",
    name: "get_store_scene",
    parameters: {
      additionalProperties: false,
      properties: {
        scene_id: { description: "Store scene id from search_store_scenes or the frame's assigned scenes.", type: "string" },
      },
      required: ["scene_id"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Deliver newly built scene(s) to the user's editor. Validates the JSON first; on validation errors, " +
      "fix them and call again. Only call with complete, final scene JSON.",
    name: "create_scenes",
    parameters: {
      additionalProperties: false,
      properties: {
        scenes: {
          description: "Array of complete FrameOS scene JSON objects.",
          items: { type: "object" },
          type: "array",
        },
        title: { description: "Short human title for what was built.", type: "string" },
      },
      required: ["title", "scenes"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Save a scene to the user's account as a NEW private store scene, so it survives closing the editor " +
      "and can be installed on a frame or forked later. With no arguments it saves whatever you just " +
      "delivered with create_scenes/update_scene; pass `scenes` to save something else. When the scene " +
      "started life as a store scene (you fetched it with get_store_scene, or the user opened it from the " +
      "store), ALSO pass its id as `source_scene_id`: the copy is then a proper fork that keeps the " +
      "original's preview image, tags and description and records where it came from. It always creates a " +
      "copy and never overwrites an existing saved scene, so say which name it landed under. Call it when " +
      "the user asks to save, keep or fork — not on every build.",
    name: "save_scene",
    parameters: {
      additionalProperties: false,
      properties: {
        description: {
          description: "Optional one-line description for the store listing.",
          type: "string",
        },
        name: {
          description:
            "Name to save under. Defaults to the scene's own name; a clash gets ' 2' appended.",
          type: "string",
        },
        scenes: {
          description:
            "Complete scene JSON to save. Omit to save the scene you just delivered.",
          items: { type: "object" },
          type: "array",
        },
        source_scene_id: {
          description:
            "Store scene id this is a copy of (from get_store_scene / search_store_scenes). Makes the save " +
            "a fork with lineage: preview image, tags and description carry over. Omit for brand-new scenes.",
          type: "string",
        },
      },
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Deliver a modified version of the user's CURRENT scene to the editor. Send the complete updated " +
      "scene JSON (not a diff). Keeps the current scene id. Validates first; fix reported issues and retry.",
    name: "update_scene",
    parameters: {
      additionalProperties: false,
      properties: {
        rewrite: {
          description:
            "Set true ONLY when the user asked to replace most of the scene (\"start over\", \"remove everything except…\"). " +
            "Without it, a scene that drops most of the current nodes is refused as an accidental partial update.",
          type: "boolean",
        },
        scene: { description: "The complete updated FrameOS scene JSON object.", type: "object" },
      },
      required: ["scene"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Change PART of the user's CURRENT scene without resending the rest. Send only what changes: nodes to " +
      "add/replace (matched by id), node ids to remove (their edges go too), edges to add/replace/remove, " +
      "the scene's fields, settings to merge, and per-app source files to replace (apps.<keyword>.sources.<file>; " +
      "null removes a file or an app). Everything not mentioned stays exactly as it is. The merged scene is " +
      "validated like update_scene and delivered to the editor. Prefer this over update_scene for any edit that " +
      "leaves most of the scene alone — it costs a fraction of the tokens.",
    name: "patch_scene",
    parameters: {
      additionalProperties: false,
      properties: {
        apps: {
          additionalProperties: true,
          description:
            'Per-app changes keyed by app keyword: { "weatherPanel": { "sources": { "app.ts": "<full new file>", "old.ts": null } } }. ' +
            "Other keys of the app entry are shallow-merged; a null app entry removes the app.",
          type: "object",
        },
        fields: {
          description: "Replacement for the scene's whole `fields` array (omit to keep it).",
          items: { type: "object" },
          type: "array",
        },
        name: { description: "New scene name (omit to keep it).", type: "string" },
        remove_edges: {
          description:
            "Edges to remove: edge ids, or { source, target, sourceHandle?, targetHandle? } matchers for edges without ids.",
          items: { anyOf: [{ type: "string" }, { type: "object" }] },
          type: "array",
        },
        remove_nodes: {
          description: "Ids of nodes to remove. Edges touching them are removed as well.",
          items: { type: "string" },
          type: "array",
        },
        set_edges: {
          description: "Complete edge objects to add, or to replace when an edge with the same id exists.",
          items: { type: "object" },
          type: "array",
        },
        set_nodes: {
          description:
            "Complete node objects to add, or to replace when a node with the same id exists. Send the whole node, not a diff of it.",
          items: { type: "object" },
          type: "array",
        },
        settings: {
          additionalProperties: true,
          description: "Keys to merge into the scene's settings.",
          type: "object",
        },
      },
      type: "object",
    },
    type: "function",
  },
  {
    description:
      "Edit source code inside the user's CURRENT scene with exact find/replace, without resending the file. " +
      "Targets an app's source file (app + file, e.g. weatherPanel / app.ts), a node's inline sources " +
      "(node_id + file), or a code node's snippet (node_id alone). Each `find` must match exactly once " +
      "(set all: true to replace every occurrence); a miss reports the problem and changes nothing. The " +
      "edited scene is validated and delivered to the editor. Cheapest way to change a few lines; for a " +
      "rewrite of most of a file use patch_scene with the full new source instead.",
    name: "edit_app_source",
    parameters: {
      additionalProperties: false,
      properties: {
        app: { description: "App keyword in the scene's `apps` map (for app sources).", type: "string" },
        edits: {
          description: "Ordered edits; applied in sequence, each against the result of the previous.",
          items: {
            additionalProperties: false,
            properties: {
              all: { description: "Replace every occurrence instead of requiring exactly one.", type: "boolean" },
              find: { description: "Exact text to find (whitespace included).", type: "string" },
              replace: { description: "Replacement text (empty string deletes).", type: "string" },
            },
            required: ["find", "replace"],
            type: "object",
          },
          type: "array",
        },
        file: {
          description: 'File name inside the app\'s sources, e.g. "app.ts" or "config.json". Omit for a code node.',
          type: "string",
        },
        node_id: { description: "Node id (for node-level sources or a code node).", type: "string" },
      },
      required: ["edits"],
      type: "object",
    },
    type: "function",
  },
];

// Short human labels the SPA shows in the activity log while a tool runs.
export const toolLabels: Record<string, string> = {
  add_scene_to_frame: "Installing scene on frame",
  create_scenes: "Building scene",
  get_app: "Reading app config",
  get_example: "Reading example scene",
  get_frame: "Inspecting frame",
  get_frame_logs: "Reading frame logs",
  get_frame_metrics: "Reading frame metrics",
  get_store_scene: "Reading store scene",
  list_frames: "Listing frames",
  list_repo_files: "Listing source files",
  read_doc: "Reading documentation",
  read_repo_file: "Reading source code",
  request_live_metrics: "Requesting live metrics",
  save_scene: "Saving scene to your account",
  search_apps: "Searching apps",
  search_docs: "Searching documentation",
  search_examples: "Searching examples",
  search_store_scenes: "Searching the store",
  update_scene: "Updating scene",
  patch_scene: "Patching scene",
  edit_app_source: "Editing app source",
};

function clampInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncateResult(serialized: string): string {
  if (serialized.length <= MAX_TOOL_OUTPUT_CHARS) {
    return serialized;
  }
  return `${serialized.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...(truncated at ${MAX_TOOL_OUTPUT_CHARS} chars)`;
}

async function ownedFrame(ctx: ToolContext, frameIdArg: unknown) {
  const frameId = asString(frameIdArg);
  if (!frameId) {
    throw new Error("frame_id is required");
  }
  const frame = await frameForAccount(ctx.db, ctx.accountId, frameId);
  if (!frame) {
    throw new Error(`No frame with id ${frameId} in this account`);
  }
  return frame;
}

async function assignedScenes(ctx: ToolContext, frameId: string) {
  return ctx.db
    .select({
      name: storeScenes.name,
      position: frameSceneAssignments.position,
      sceneId: frameSceneAssignments.sceneId,
      sceneVersion: frameSceneAssignments.sceneVersion,
    })
    .from(frameSceneAssignments)
    .innerJoin(storeScenes, eq(storeScenes.id, frameSceneAssignments.sceneId))
    .where(eq(frameSceneAssignments.frameId, frameId))
    .orderBy(frameSceneAssignments.position);
}

// Lint issues are keyed by message so a modification is judged on what it
// CHANGED: a scene fetched from the store may carry legacy values the model
// never touched (an old sample's "position": "top-left"), and bouncing the
// update over those would block every edit to such a scene.
function lintKey(issue: LintIssue): string {
  return `${issue.level}|${issue.node ?? ""}|${issue.message}`;
}

function newIssues(issues: LintIssue[], baseline: LintIssue[]): LintIssue[] {
  const seen = new Set(baseline.map(lintKey));
  return issues.filter((issue) => !seen.has(lintKey(issue)));
}

// update_scene must carry the WHOLE scene. A model under time pressure sends
// just the nodes it touched (three clock nodes standing in for a 32-node
// weather scene), which the editor would faithfully apply as "delete the
// rest". Refuse when most of the current nodes vanish, unless the model says
// the user asked for a rewrite.
function partialSceneIssue(current: JsonObject, delivered: JsonObject): string | undefined {
  const ids = (scene: JsonObject) =>
    new Set(
      (Array.isArray(scene.nodes) ? scene.nodes : [])
        .map((node) => (node as JsonObject)?.id)
        .filter((id): id is string => typeof id === "string"),
    );
  const before = ids(current);
  const after = ids(delivered);
  if (before.size < 4) {
    return undefined;
  }
  const kept = [...before].filter((id) => after.has(id)).length;
  if (kept / before.size >= 0.5) {
    return undefined;
  }
  return (
    `This looks like a partial update: the current scene has ${before.size} nodes and only ${kept} of their ids are in the delivered scene ` +
    `(${after.size} nodes). update_scene replaces the WHOLE scene. Either call patch_scene / edit_app_source with just the parts that change ` +
    `(nodes by id, app source files, find/replace edits — cheapest, preferred), or send the complete scene — every existing node, edge, field ` +
    `and the "apps" map — with your changes applied and the original node ids kept. If the user really asked to replace most of the scene, ` +
    `call update_scene again with rewrite: true. Do this now, in this turn; do not ask the user whether to retry.`
  );
}

function deliverScenes(
  ctx: ToolContext,
  rawScenes: unknown,
  tool: "build_scene" | "modify_scene",
  title?: string,
  options: { rewrite?: boolean } = {},
): string {
  const scenes = Array.isArray(rawScenes) ? rawScenes : [];
  const payload: JsonObject = { scenes };
  if (tool === "modify_scene" && scenes.length > 0) {
    const first = scenes[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const entry = first as JsonObject;
      if (ctx.currentSceneId) {
        entry.id = ctx.currentSceneId;
      }
      if (!entry.name && ctx.currentScene?.name) {
        entry.name = ctx.currentScene.name;
      }
    }
  }
  const issues = [
    ...validateScenePayload(payload),
    ...validateAppKeywords(payload, knownAppKeywords()),
  ];
  if (issues.length > 0) {
    return JSON.stringify({ ok: false, issues });
  }
  if (tool === "modify_scene" && ctx.currentScene && !options.rewrite) {
    const partial = partialSceneIssue(ctx.currentScene, scenes[0] as JsonObject);
    if (partial) {
      return JSON.stringify({ issues: [partial], ok: false });
    }
  }
  const bundled = bundleRepoApps(payload, appCatalog());

  // Deep structural lint against the app catalog. Scene-node references may
  // point at scenes that stay untouched in the editor, so lint with those in
  // view; report only what the delivered scenes themselves get wrong.
  const deliveredIds = new Set(
    scenes.map((scene) => (scene as JsonObject)?.id).filter((id) => typeof id === "string"),
  );
  const companions = (ctx.editorScenes ?? []).filter(
    (scene) => !deliveredIds.has((scene as JsonObject)?.id as string),
  );
  const lint = lintScenes([...scenes, ...companions]);
  const deliveredNames = new Set(
    scenes.map((scene) => {
      const entry = scene as JsonObject;
      return (typeof entry?.name === "string" && entry.name) || (entry?.id as string) || "scene";
    }),
  );
  let errors = lint.errors.filter((issue) => deliveredNames.has(issue.scene));
  let warnings = lint.warnings.filter((issue) => deliveredNames.has(issue.scene));
  if (tool === "modify_scene" && ctx.currentScene) {
    const baseline = lintScenes([ctx.currentScene, ...companions]);
    errors = newIssues(errors, baseline.errors);
    warnings = newIssues(warnings, baseline.warnings);
  }
  if (errors.length > 0) {
    return JSON.stringify({
      issues: formatLintIssues(errors),
      note:
        "The scene did not reach the editor. Fix every issue (check the app's fields with get_app) and call the tool again with the complete corrected scene.",
      ok: false,
      ...(warnings.length > 0 ? { warnings: formatLintIssues(warnings) } : {}),
    });
  }

  splitStateNodesByApp(payload);
  ctx.deliveredTool = tool;
  ctx.deliveredScenes = payload.scenes as unknown[];
  ctx.emitScenes({
    scenes: payload.scenes as unknown[],
    ...(title ? { title } : {}),
    tool,
    type: "scenes",
  });
  return JSON.stringify({
    delivered: true,
    note:
      "The scene is now in the user's editor as an unsaved change. Either remind them to review and save, " +
      "or call save_scene to save a copy to their account for them.",
    ok: true,
    ...(bundled.length > 0
      ? {
          bundledApps: bundled,
          bundledNote:
            "Repo JS apps were bundled into the scene's own apps map under their short keywords (as the runtime requires); the delivered scene uses those keywords.",
        }
      : {}),
    ...(warnings.length > 0
      ? {
          warnings: formatLintIssues(warnings),
          warningsNote:
            "Delivered despite these warnings. Fix them with another call only if they affect what the user asked for.",
        }
      : {}),
  });
}


// ---------------------------------------------------------------------------
// Partial edits: patch_scene / edit_app_source.
//
// Before these existed the only way to change one line of a bundled app was
// to resend the entire scene (74 KB for the store's Weather scene), which
// took minutes of silent generation, hit timeouts, and tempted the model
// into "partial" update_scene calls that the guard above then refused. Both
// tools merge onto the scene the chat is holding and run the exact same
// validation + lint + delivery as update_scene.

// The scene a partial edit applies to: what this turn already delivered, or
// the editor's current scene.
export function workingScene(ctx: ToolContext): JsonObject | null {
  const delivered = ctx.deliveredScenes?.[0];
  if (ctx.deliveredTool === "modify_scene" && delivered && typeof delivered === "object") {
    return delivered as JsonObject;
  }
  return ctx.currentScene ?? null;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function objectList(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

type EdgeMatcher = { source?: unknown; target?: unknown; sourceHandle?: unknown; targetHandle?: unknown };

function edgeMatches(edge: JsonObject, matcher: EdgeMatcher): boolean {
  if (matcher.source !== undefined && edge.source !== matcher.source) {
    return false;
  }
  if (matcher.target !== undefined && edge.target !== matcher.target) {
    return false;
  }
  if (matcher.sourceHandle !== undefined && edge.sourceHandle !== matcher.sourceHandle) {
    return false;
  }
  if (matcher.targetHandle !== undefined && edge.targetHandle !== matcher.targetHandle) {
    return false;
  }
  return true;
}

export type ScenePatchResult = { scene: JsonObject; changes: string[]; issues: string[] };

// Pure merge of a patch_scene payload onto a scene. `issues` lists what could
// not be applied (unknown ids, malformed entries); the caller refuses the
// whole patch when there are any, so a typo never silently half-applies.
export function applyScenePatch(base: JsonObject, args: JsonObject): ScenePatchResult {
  const scene = cloneJson(base);
  const changes: string[] = [];
  const issues: string[] = [];
  const nodes = objectList(scene.nodes);
  let edges = objectList(scene.edges);

  if (typeof args.name === "string" && args.name.trim()) {
    scene.name = args.name.trim();
    changes.push(`renamed scene to "${scene.name}"`);
  }

  const removeNodes = new Set(stringList(args.remove_nodes));
  for (const id of removeNodes) {
    if (!nodes.some((node) => node.id === id)) {
      issues.push(`remove_nodes: no node with id "${id}".`);
    }
  }
  if (removeNodes.size > 0 && issues.length === 0) {
    const before = edges.length;
    edges = edges.filter(
      (edge) => !removeNodes.has(edge.source as string) && !removeNodes.has(edge.target as string),
    );
    changes.push(
      `removed ${removeNodes.size} node(s)` + (before !== edges.length ? ` and ${before - edges.length} attached edge(s)` : ""),
    );
  }
  let nextNodes = nodes.filter((node) => !removeNodes.has(node.id as string));

  const setNodes = objectList(args.set_nodes);
  let added = 0;
  let replaced = 0;
  for (const node of setNodes) {
    if (typeof node.id !== "string" || !node.id) {
      issues.push("set_nodes: every node needs a string id.");
      continue;
    }
    if (typeof node.type !== "string" || !node.type) {
      issues.push(`set_nodes: node "${node.id}" needs a type.`);
      continue;
    }
    const index = nextNodes.findIndex((existing) => existing.id === node.id);
    if (index === -1) {
      nextNodes = [...nextNodes, node];
      added += 1;
    } else {
      nextNodes[index] = node;
      replaced += 1;
    }
  }
  if (added || replaced) {
    changes.push(`nodes: ${replaced} replaced, ${added} added`);
  }

  const removeEdges = Array.isArray(args.remove_edges) ? args.remove_edges : [];
  let removedEdges = 0;
  for (const matcher of removeEdges) {
    const before = edges.length;
    if (typeof matcher === "string") {
      edges = edges.filter((edge) => edge.id !== matcher);
    } else if (matcher && typeof matcher === "object") {
      edges = edges.filter((edge) => !edgeMatches(edge, matcher as EdgeMatcher));
    } else {
      issues.push("remove_edges: entries must be edge ids or {source,target} matchers.");
      continue;
    }
    if (edges.length === before) {
      issues.push(`remove_edges: nothing matched ${JSON.stringify(matcher)}.`);
    }
    removedEdges += before - edges.length;
  }
  if (removedEdges) {
    changes.push(`removed ${removedEdges} edge(s)`);
  }

  const setEdges = objectList(args.set_edges);
  let edgesAdded = 0;
  let edgesReplaced = 0;
  for (const edge of setEdges) {
    if (typeof edge.source !== "string" || typeof edge.target !== "string") {
      issues.push("set_edges: every edge needs string source and target node ids.");
      continue;
    }
    const index = typeof edge.id === "string" ? edges.findIndex((existing) => existing.id === edge.id) : -1;
    if (index === -1) {
      edges = [...edges, edge];
      edgesAdded += 1;
    } else {
      edges[index] = edge;
      edgesReplaced += 1;
    }
  }
  if (edgesAdded || edgesReplaced) {
    changes.push(`edges: ${edgesReplaced} replaced, ${edgesAdded} added`);
  }

  if (Array.isArray(args.fields)) {
    scene.fields = args.fields;
    changes.push(`fields replaced (${args.fields.length})`);
  }
  if (args.settings && typeof args.settings === "object" && !Array.isArray(args.settings)) {
    scene.settings = { ...((scene.settings as JsonObject) ?? {}), ...(args.settings as JsonObject) };
    changes.push(`settings merged (${Object.keys(args.settings as JsonObject).join(", ")})`);
  }

  if (args.apps && typeof args.apps === "object" && !Array.isArray(args.apps)) {
    const apps = { ...((scene.apps as JsonObject) ?? {}) };
    for (const [keyword, patch] of Object.entries(args.apps as JsonObject)) {
      if (patch === null) {
        if (!(keyword in apps)) {
          issues.push(`apps: no app "${keyword}" to remove.`);
          continue;
        }
        delete apps[keyword];
        changes.push(`removed app ${keyword}`);
        continue;
      }
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        issues.push(`apps.${keyword}: must be an object or null.`);
        continue;
      }
      const existing = (apps[keyword] as JsonObject | undefined) ?? {};
      const { sources: sourcePatch, ...rest } = patch as JsonObject;
      const merged: JsonObject = { ...existing, ...rest };
      if (sourcePatch !== undefined) {
        if (!sourcePatch || typeof sourcePatch !== "object" || Array.isArray(sourcePatch)) {
          issues.push(`apps.${keyword}.sources: must be a { file: content } object.`);
          continue;
        }
        const sources = { ...((existing.sources as JsonObject) ?? {}) };
        const touched: string[] = [];
        for (const [file, content] of Object.entries(sourcePatch as JsonObject)) {
          if (content === null) {
            if (!(file in sources)) {
              issues.push(`apps.${keyword}.sources: no file "${file}" to remove.`);
              continue;
            }
            delete sources[file];
            touched.push(`-${file}`);
          } else if (typeof content === "string") {
            touched.push(file in sources ? file : `+${file}`);
            sources[file] = content;
          } else {
            issues.push(`apps.${keyword}.sources.${file}: content must be a string (or null to remove).`);
          }
        }
        merged.sources = sources;
        if (touched.length > 0) {
          changes.push(`app ${keyword} sources: ${touched.join(", ")}`);
        }
      } else if (Object.keys(rest).length > 0) {
        changes.push(`app ${keyword}: ${Object.keys(rest).join(", ")} updated`);
      }
      apps[keyword] = merged;
    }
    scene.apps = apps;
  }

  scene.nodes = nextNodes;
  scene.edges = edges;
  return { changes, issues, scene };
}

export type SourceEditResult = { scene: JsonObject; issues: string[]; summary: string };

// Pure find/replace inside one source string of a scene. Refuses (issues)
// when a find is ambiguous or missing, so the model gets a precise reason
// instead of a silently unchanged file.
export function applySourceEdits(base: JsonObject, args: JsonObject): SourceEditResult {
  const scene = cloneJson(base);
  const issues: string[] = [];
  const edits = objectList(args.edits);
  const app = typeof args.app === "string" ? args.app : undefined;
  const nodeId = typeof args.node_id === "string" ? args.node_id : undefined;
  const file = typeof args.file === "string" ? args.file : undefined;
  if (edits.length === 0) {
    return { issues: ["edits: send at least one { find, replace }."], scene, summary: "" };
  }
  if (!app && !nodeId) {
    return { issues: ["Name the target: `app` (+ `file`) for a bundled app, or `node_id` for a node."], scene, summary: "" };
  }

  // Locate the string and a setter for it.
  let current: string | undefined;
  let setter: ((value: string) => void) | undefined;
  let where = "";
  if (app) {
    const apps = (scene.apps as JsonObject | undefined) ?? {};
    const entry = apps[app] as JsonObject | undefined;
    if (!entry) {
      issues.push(`No app "${app}" in this scene's apps map (have: ${Object.keys(apps).join(", ") || "none"}).`);
    } else {
      const sources = (entry.sources as JsonObject | undefined) ?? {};
      const target = file ?? (Object.keys(sources).length === 1 ? Object.keys(sources)[0] : undefined);
      if (!target) {
        issues.push(`Which file? App "${app}" has: ${Object.keys(sources).join(", ") || "no sources"}.`);
      } else if (typeof sources[target] !== "string") {
        issues.push(`App "${app}" has no file "${target}" (have: ${Object.keys(sources).join(", ") || "none"}).`);
      } else {
        current = sources[target] as string;
        setter = (value) => {
          sources[target] = value;
          entry.sources = sources;
        };
        where = `${app}/${target}`;
      }
    }
  } else if (nodeId) {
    const node = objectList(scene.nodes).find((candidate) => candidate.id === nodeId);
    if (!node) {
      issues.push(`No node with id "${nodeId}".`);
    } else {
      const data = ((node.data as JsonObject | undefined) ?? {}) as JsonObject;
      node.data = data;
      const sources = data.sources as JsonObject | undefined;
      if (file && sources && typeof sources[file] === "string") {
        current = sources[file] as string;
        setter = (value) => {
          sources[file] = value;
        };
        where = `node ${nodeId}/${file}`;
      } else if (!file && node.type === "code" && typeof data.codeJS === "string") {
        current = data.codeJS;
        setter = (value) => {
          data.codeJS = value;
        };
        where = `code node ${nodeId}`;
      } else if (!file && sources && Object.keys(sources).length === 1) {
        const only = Object.keys(sources)[0]!;
        current = sources[only] as string;
        setter = (value) => {
          sources[only] = value;
        };
        where = `node ${nodeId}/${only}`;
      } else {
        issues.push(
          `Node "${nodeId}" has no editable source${file ? ` "${file}"` : ""} (` +
            (sources ? `files: ${Object.keys(sources).join(", ")}` : node.type === "code" ? "no codeJS" : "not a code node and no sources") +
            ").",
        );
      }
    }
  }
  if (current === undefined || !setter) {
    return { issues, scene, summary: "" };
  }

  let working = current;
  let replacements = 0;
  edits.forEach((edit, index) => {
    const find = edit.find;
    const replace = typeof edit.replace === "string" ? edit.replace : "";
    if (typeof find !== "string" || !find) {
      issues.push(`edits[${index}]: find must be a non-empty string.`);
      return;
    }
    const count = working.split(find).length - 1;
    if (count === 0) {
      const firstLine = find.split("\n")[0] ?? find;
      issues.push(
        `edits[${index}]: not found in ${where}: ${JSON.stringify(firstLine.slice(0, 80))}${find.includes("\n") ? " (first line shown)" : ""}. Check whitespace and quote the text exactly as it appears.`,
      );
      return;
    }
    if (count > 1 && edit.all !== true) {
      issues.push(`edits[${index}]: matches ${count} times in ${where}; include more surrounding text or set all: true.`);
      return;
    }
    working = edit.all === true ? working.split(find).join(replace) : working.replace(find, () => replace);
    replacements += count;
  });
  if (issues.length > 0) {
    return { issues, scene: cloneJson(base), summary: "" };
  }
  setter(working);
  return { issues, scene, summary: `${where}: ${replacements} replacement(s), ${current.length} → ${working.length} chars` };
}

function noWorkingScene(): string {
  return JSON.stringify({
    error:
      "There is no current scene in this chat to edit. Ask the user to open a scene, or build one with create_scenes.",
  });
}

async function patchScene(ctx: ToolContext, args: JsonObject): Promise<string> {
  const base = workingScene(ctx);
  if (!base) {
    return noWorkingScene();
  }
  const { changes, issues, scene } = applyScenePatch(base, args);
  if (issues.length > 0) {
    return JSON.stringify({ issues, note: "Nothing was applied. Fix the patch and call again.", ok: false });
  }
  if (changes.length === 0) {
    return JSON.stringify({ issues: ["The patch changes nothing."], ok: false });
  }
  const delivered = deliverScenes(ctx, [scene], "modify_scene", undefined, { rewrite: true });
  return withChanges(delivered, changes);
}

async function editAppSource(ctx: ToolContext, args: JsonObject): Promise<string> {
  const base = workingScene(ctx);
  if (!base) {
    return noWorkingScene();
  }
  const { issues, scene, summary } = applySourceEdits(base, args);
  if (issues.length > 0) {
    return JSON.stringify({ issues, note: "Nothing was changed. Fix the edits and call again.", ok: false });
  }
  const delivered = deliverScenes(ctx, [scene], "modify_scene", undefined, { rewrite: true });
  return withChanges(delivered, [summary]);
}

// Prefix the delivery result with what the merge did, so the model can see
// its patch landed as intended.
function withChanges(delivered: string, changes: string[]): string {
  try {
    const parsed = JSON.parse(delivered) as JsonObject;
    return JSON.stringify({ applied: changes, ...parsed });
  } catch {
    return delivered;
  }
}

// Save whatever the chat is holding into the user's account as a NEW private
// scene. Never an overwrite: a chat that could rewrite a saved scene in place
// would be one bad turn away from destroying work the user did not ask it to
// touch, and "save a copy" is also exactly what forking someone else's store
// scene means. The user renames or deletes from the store page afterwards.
async function saveSceneToAccount(
  ctx: ToolContext,
  args: JsonObject,
): Promise<string> {
  const explicit = Array.isArray(args.scenes) ? (args.scenes as unknown[]) : null;
  const scenes =
    explicit ??
    ctx.deliveredScenes ??
    (ctx.currentScene ? [ctx.currentScene] : null);
  if (!scenes || scenes.length === 0) {
    return JSON.stringify({
      error:
        "Nothing to save. Build the scene with create_scenes (or ask the user to open one) before calling save_scene.",
    });
  }
  const requestedName =
    asString(args.name) ??
    (typeof (scenes[0] as JsonObject)?.name === "string"
      ? ((scenes[0] as JsonObject).name as string)
      : undefined) ??
    "Untitled scene";
  const description = asString(args.description);
  // A chat opened on a store scene forks THAT scene unless the model names
  // another source — the editor's fork button has the same default.
  const sourceSceneId = asString(args.source_scene_id) ?? ctx.storeSceneId ?? undefined;
  const actor = {
    accountId: ctx.accountId,
    providerSubject: ctx.providerSubject ?? "",
  };

  if (sourceSceneId && !sceneIdPattern.test(sourceSceneId)) {
    return JSON.stringify({
      error: "source_scene_id must be a store scene uuid (or omit it for a brand-new scene)",
      ok: false,
    });
  }
  // A copy of a store scene is a FORK, and forks go through the same lib the
  // workspace's fork button uses — so the audit event names the source, and
  // the preview image, gallery, tags and description come along. Only the
  // name is the model's to choose; the fork lib keeps it unique per account.
  const response = sourceSceneId
    ? await forkStoreScene(ctx.db, {
        accountId: ctx.accountId,
        actor,
        ...(description ? { description } : {}),
        ...(asString(args.name) ? { name: asString(args.name) } : {}),
        scenes,
        sourceSceneId,
        via: "ai_chat",
      })
    : await createAccountScene(ctx.db, {
        accountId: ctx.accountId,
        actor,
        ...(description ? { description } : {}),
        name: requestedName,
        scenes,
      });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    scene?: { id?: string; name?: string; slug?: string };
  };
  if (!response.ok) {
    // The refusal codes are the store's own (quota, moderation, size) — hand
    // them back so the model can explain rather than retry blindly.
    return JSON.stringify({
      error: body.error ?? `save_failed_${response.status}`,
      ok: false,
    });
  }
  return JSON.stringify({
    note:
      (sourceSceneId
        ? "Forked into a PRIVATE scene in the user's account, with the original's preview image, tags and " +
          "description carried over. "
        : "Saved as a PRIVATE scene in the user's account. ") +
      "It is a copy — the editor still holds their unsaved version, and nothing was overwritten.",
    ok: true,
    scene: body.scene ?? null,
  });
}

export async function executeTool(
  name: string,
  args: JsonObject,
  ctx: ToolContext,
): Promise<string> {
  switch (name) {
    case "search_apps": {
      const results = searchApps(asString(args.query), asString(args.category)).map((app) => ({
        category: app.category,
        description: app.description,
        fields: Array.isArray(app.fields)
          ? app.fields
              .map((field) => (field as JsonObject)?.name)
              .filter((fieldName) => typeof fieldName === "string")
          : [],
        keyword: app.keyword,
        name: app.name,
      }));
      return truncateResult(JSON.stringify({ apps: results }));
    }
    case "get_app": {
      const keyword = asString(args.keyword);
      const app = keyword ? getApp(keyword) : undefined;
      if (!app) {
        return JSON.stringify({
          error: `Unknown app keyword '${keyword ?? ""}'. Use search_apps to list valid keywords.`,
        });
      }
      return truncateResult(JSON.stringify({ app }));
    }
    case "search_examples": {
      const results = searchExamples(asString(args.query)).map((example) => ({
        appKeywords: [...new Set(example.summary.flatMap((scene) => scene.appKeywords))],
        description: example.description,
        name: example.name,
        sceneCount: example.scenes.length,
        slug: example.slug,
      }));
      return truncateResult(JSON.stringify({ examples: results }));
    }
    case "get_example": {
      const slug = asString(args.slug);
      const example = slug ? getExample(slug) : undefined;
      if (!example) {
        return JSON.stringify({
          error: `Unknown example '${slug ?? ""}'. Use search_examples to list them.`,
        });
      }
      return truncateResult(
        JSON.stringify({ description: example.description, name: example.name, scenes: example.scenes }),
      );
    }
    case "search_docs": {
      const query = asString(args.query);
      if (!query) {
        return JSON.stringify({ error: "query is required" });
      }
      return truncateResult(JSON.stringify({ sections: searchDocs(query) }));
    }
    case "read_doc": {
      const path = asString(args.path);
      const content = path ? readDoc(path, asString(args.heading)) : undefined;
      if (content === undefined) {
        return JSON.stringify({ error: `Unknown doc '${path ?? ""}'. Use search_docs first.` });
      }
      return truncateResult(JSON.stringify({ content, path }));
    }
    case "list_repo_files": {
      const prefix = asString(args.prefix);
      const query = asString(args.query)?.toLowerCase();
      const paths = (await repoTree())
        .filter((path) => (prefix ? path.startsWith(prefix) : true))
        .filter((path) => (query ? path.toLowerCase().includes(query) : true))
        .slice(0, 200);
      return truncateResult(JSON.stringify({ files: paths }));
    }
    case "read_repo_file": {
      const path = asString(args.path);
      if (!path || !repoPathAllowed(path)) {
        return JSON.stringify({
          error:
            "Path not readable. Readable prefixes: " + REPO_PATH_PREFIXES.join(", ") + " (Nim sources excluded).",
        });
      }
      return truncateResult(JSON.stringify({ content: await readRepoFile(path), path }));
    }
    case "list_frames": {
      const rows = await ctx.db
        .select()
        .from(frames)
        .where(eq(frames.accountId, ctx.accountId))
        .orderBy(desc(frames.lastSeenAt));
      const result = rows.map((frame) => {
        const hardware = (frame.hardware ?? {}) as JsonObject;
        return {
          connected: frame.connected,
          device: hardware.device,
          frameos_version: frame.frameosVersion,
          height: hardware.height,
          id: frame.id,
          last_seen_at: frame.lastSeenAt,
          name: frame.name,
          status: frame.status,
          width: hardware.width,
        };
      });
      return truncateResult(JSON.stringify({ frames: result }));
    }
    case "get_frame": {
      const frame = await ownedFrame(ctx, args.frame_id);
      const scenes = await assignedScenes(ctx, frame.id);
      const summary = frameSummary(frame) as JsonObject;
      const inSync =
        frame.assignedChecksum !== null &&
        frame.assignedChecksum === frame.scenesChecksum;
      return truncateResult(
        JSON.stringify({
          frame: {
            ...summary,
            assigned_scenes: scenes,
            deploy_in_sync: inSync,
            last_metrics: frame.lastMetrics,
            last_state: frame.lastState,
          },
        }),
      );
    }
    case "get_frame_logs": {
      const frame = await ownedFrame(ctx, args.frame_id);
      const limit = clampInt(args.limit, 100, MAX_LOG_LINES);
      const rows = await ctx.db
        .select()
        .from(frameLogs)
        .where(eq(frameLogs.frameId, frame.id))
        .orderBy(desc(frameLogs.id))
        .limit(limit);
      rows.reverse();
      const lines = rows.map(
        (row) => `${row.timestamp.toISOString()} ${JSON.stringify(row.payload)}`,
      );
      return truncateResult(JSON.stringify({ count: lines.length, logs: lines }));
    }
    case "get_frame_metrics": {
      const frame = await ownedFrame(ctx, args.frame_id);
      const samples = clampInt(args.samples, 20, MAX_METRIC_SAMPLES);
      const rows = await ctx.db
        .select()
        .from(frameMetrics)
        .where(eq(frameMetrics.frameId, frame.id))
        .orderBy(desc(frameMetrics.id))
        .limit(samples);
      rows.reverse();
      return truncateResult(
        JSON.stringify({
          latest: frame.lastMetrics,
          samples: rows.map((row) => ({
            metrics: row.payload,
            timestamp: row.timestamp.toISOString(),
          })),
        }),
      );
    }
    case "request_live_metrics": {
      const frame = await ownedFrame(ctx, args.frame_id);
      if (frame.status !== "active" || !frame.connected) {
        return JSON.stringify({
          error: `Frame is ${frame.status === "active" ? "offline" : frame.status}; live metrics need a connected, active frame.`,
        });
      }
      await supersedePendingCommands(ctx.db, frame.id, "get_metrics");
      await enqueueFrameCommand(ctx.db, {
        createdByAccountId: ctx.accountId,
        frameId: frame.id,
        ttlMs: 2 * 60 * 1000,
        type: "get_metrics",
      });
      return JSON.stringify({
        queued: true,
        note: "The frame reports metrics asynchronously; a fresh sample lands in get_frame_metrics within a few seconds.",
      });
    }
    // The one tool that changes what a physical frame shows. Every gate the
    // workspace's Save/Deploy runs is in assignScenesToFrame, shared with
    // app/api/frames/[frameId]/scenes/route.ts — this case only turns "add
    // one scene" into the full replacement list that helper expects.
    case "add_scene_to_frame": {
      const frame = await ownedFrame(ctx, args.frame_id);
      const sceneId = asString(args.scene_id);
      if (!sceneId) {
        return JSON.stringify({ error: "scene_id is required" });
      }
      const sceneVersion =
        typeof args.scene_version === "number" &&
        Number.isInteger(args.scene_version) &&
        args.scene_version >= 1
          ? args.scene_version
          : null;

      const existing = await currentSceneAssignments(ctx.db, frame.id);
      // Re-deploying an already-assigned scene is the useful reading of a
      // duplicate add (the user asking again usually means "it is still not
      // on there"), and the helper rejects duplicate ids outright.
      const alreadyAssigned = existing.some(
        (entry) => entry.sceneId === sceneId,
      );
      const requested = alreadyAssigned
        ? existing.map((entry) =>
            entry.sceneId === sceneId ? { sceneId, sceneVersion } : entry,
          )
        : [...existing, { sceneId, sceneVersion }];
      if (requested.length > maxScenesPerFrame) {
        return JSON.stringify({
          error: `A frame can hold at most ${maxScenesPerFrame} scenes; this one already has ${existing.length}. Ask the user which scene to remove.`,
        });
      }

      const outcome = await assignScenesToFrame(ctx.db, {
        accountId: ctx.accountId,
        actor: { accountId: ctx.accountId, via: "ai_chat" },
        frame,
        requested,
        via: "ai_chat",
      });
      if (!outcome.ok) {
        // The wire codes are meaningful to the model, but only just — spell
        // out the two it can actually do something about.
        const explanation =
          outcome.failure.code === "scene_not_allowed"
            ? "That scene version runs shell commands, which a cloud push may never carry. Tell the user it has to be installed from the frame itself."
            : outcome.failure.code === "frame_not_active"
              ? "The frame is not active yet — the owner has to confirm it before scenes can be pushed."
              : outcome.failure.code;
        return JSON.stringify({
          error: explanation,
          ...(outcome.failure.detail ?? {}),
        });
      }
      return JSON.stringify({
        assigned_scenes: outcome.result.sceneNames,
        deployed: true,
        note: frame.connected
          ? "Installed and deployed. The frame applies it within seconds; no further action from the user."
          : "Installed. The frame is offline, so the deploy is queued and lands when it reconnects.",
        re_deployed: alreadyAssigned,
      });
    }
    case "search_store_scenes": {
      const query = asString(args.query)?.toLowerCase();
      // Same visibility rules as the store front (no verified-publisher
      // gate — verification is a trust signal in the results, not a filter),
      // widened with the user's own scenes regardless of visibility.
      const rows = await ctx.db
        .select({
          accountId: storeScenes.accountId,
          category: storeScenes.category,
          description: storeScenes.description,
          downloadCount: storeScenes.downloadCount,
          id: storeScenes.id,
          name: storeScenes.name,
          publisher: accounts.displayName,
          slug: storeScenes.slug,
          tags: storeScenes.tags,
          verifiedPublisherAt: accounts.verifiedPublisherAt,
          visibility: storeScenes.visibility,
        })
        .from(storeScenes)
        .innerJoin(accounts, eq(accounts.id, storeScenes.accountId))
        .where(
          and(
            eq(storeScenes.status, "active"),
            gt(storeScenes.latestVersion, 0),
            or(
              eq(storeScenes.accountId, ctx.accountId),
              and(
                eq(storeScenes.visibility, "public"),
                isNull(accounts.storeBannedAt),
              ),
            ),
          ),
        )
        .orderBy(
          desc(eq(storeScenes.accountId, ctx.accountId)),
          desc(storeScenes.downloadCount),
          desc(storeScenes.updatedAt),
        )
        .limit(100);
      const results = (
        query
          ? rows.filter((row) =>
              `${row.name} ${row.description ?? ""} ${(row.tags ?? []).join(" ")} ${row.category ?? ""} ${row.publisher ?? ""}`
                .toLowerCase()
                .includes(query),
            )
          : rows
      ).map(({ accountId, verifiedPublisherAt, ...row }) => ({
        ...row,
        owned_by_user: accountId === ctx.accountId,
        verified_publisher: verifiedPublisherAt !== null,
      }));
      return truncateResult(JSON.stringify({ scenes: results.slice(0, 50) }));
    }
    case "get_store_scene": {
      const sceneId = asString(args.scene_id);
      if (!sceneId || !/^[0-9a-f-]{36}$/i.test(sceneId)) {
        return JSON.stringify({ error: "scene_id must be a store scene uuid" });
      }
      // Readable: public scenes, the user's own scenes, and anything
      // installed on one of the user's frames (even if it has since gone
      // private or was pulled — the frame already runs those bytes and the
      // AI needs them to debug or modify what is on the wall).
      const installedOnOwnFrame = exists(
        ctx.db
          .select({ id: frameSceneAssignments.id })
          .from(frameSceneAssignments)
          .innerJoin(frames, eq(frames.id, frameSceneAssignments.frameId))
          .where(
            and(
              eq(frameSceneAssignments.sceneId, storeScenes.id),
              eq(frames.accountId, ctx.accountId),
            ),
          ),
      );
      const [scene] = await ctx.db
        .select()
        .from(storeScenes)
        .where(
          and(
            eq(storeScenes.id, sceneId),
            or(
              eq(storeScenes.accountId, ctx.accountId),
              and(eq(storeScenes.visibility, "public"), eq(storeScenes.status, "active")),
              installedOnOwnFrame,
            ),
          ),
        )
        .limit(1);
      if (!scene) {
        return JSON.stringify({ error: `No accessible store scene with id ${sceneId}` });
      }
      const [version] = await ctx.db
        .select()
        .from(storeSceneVersions)
        .where(
          and(eq(storeSceneVersions.sceneId, scene.id), isNull(storeSceneVersions.yankedAt)),
        )
        .orderBy(desc(storeSceneVersions.version))
        .limit(1);
      const versionContent = await readBlob(version);
      const scenesJson = versionContent
        ? extractScenesFromZip(versionContent)
        : undefined;
      if (!scenesJson) {
        return JSON.stringify({ error: "This store scene has no readable scenes.json." });
      }
      return truncateResult(
        JSON.stringify({
          description: scene.description,
          name: scene.name,
          owned_by_user: scene.accountId === ctx.accountId,
          scenes: scenesJson,
          version: version?.version,
        }),
      );
    }
    case "create_scenes": {
      return deliverScenes(ctx, args.scenes, "build_scene", asString(args.title));
    }
    case "save_scene": {
      return saveSceneToAccount(ctx, args);
    }
    case "update_scene": {
      if (!ctx.currentScene && !ctx.currentSceneId) {
        return JSON.stringify({
          error:
            "There is no current scene in this chat. Use create_scenes to build a new one, or ask the user to open a scene.",
        });
      }
      return deliverScenes(ctx, args.scene ? [args.scene] : [], "modify_scene", undefined, {
        rewrite: args.rewrite === true,
      });
    }
    case "patch_scene": {
      return patchScene(ctx, args);
    }
    case "edit_app_source": {
      return editAppSource(ctx, args);
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
