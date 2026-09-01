// The scene shapes the converter touches. Scenes are plain JSON from
// scenes.json (frontend/src/types.tsx is the editor's view of the same
// data); everything here is deliberately loose so the converter can take a
// scene it has never seen and hand it back with the same unknown keys intact.

export type JsonObject = Record<string, unknown>;

export type CodeArg = { name: string; type?: string };

export type SceneNode = {
  id: string;
  type?: string;
  data?: JsonObject;
  [key: string]: unknown;
};

export type SceneEdge = {
  id?: string;
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
  type?: string;
  [key: string]: unknown;
};

export type SceneApp = {
  name?: string;
  category?: string;
  sources?: Record<string, string>;
  [key: string]: unknown;
};

export type Scene = {
  id: string;
  name?: string;
  settings?: JsonObject;
  fields?: JsonObject[];
  nodes?: SceneNode[];
  edges?: SceneEdge[];
  apps?: Record<string, SceneApp>;
  [key: string]: unknown;
};

/** How one Nim thing (a code node, an app, a source node) came out. */
export type ConversionItem =
  | {
      kind: "code";
      nodeId: string;
      status: "converted";
      via: "deterministic" | "model";
      nim: string;
      js: string;
      attempts?: number;
    }
  | {
      kind: "code";
      nodeId: string;
      status: "needs_model" | "needs_manual_port";
      nim: string;
      reason: string;
    }
  | {
      kind: "code";
      nodeId: string;
      status: "already_javascript";
    }
  | {
      kind: "app";
      /** Node id for an inline `data.sources` app, `apps/<key>` for a scene app. */
      id: string;
      name: string;
      status: "converted";
      via: "model";
      category: string;
      files: string[];
      attempts: number;
      /** The render/image node inserted after a former render app. */
      insertedRenderImageNodeId?: string;
    }
  | {
      kind: "app";
      id: string;
      name: string;
      status: "needs_model" | "needs_manual_port";
      reason: string;
    }
  | {
      /** Already had JavaScript sources; only its leftover Nim was removed. */
      kind: "app";
      id: string;
      name: string;
      status: "already_javascript";
    }
  | {
      kind: "source";
      nodeId: string;
      status: "needs_manual_port";
      reason: string;
    }
  | {
      kind: "arg";
      nodeId: string;
      status: "renamed";
      from: string;
      to: string;
      reason: string;
    }
  | {
      kind: "edge";
      edgeId: string;
      nodeId: string;
      status: "dropped" | "declared" | "rewritten";
      handle: string;
      reason: string;
    };

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export type ConversionReport = {
  sceneId: string;
  sceneName: string;
  /** What the scene was stamped with before the converter ran. */
  executionBefore: string;
  /** What it is stamped with now. "compiled" means something is left over. */
  executionAfter: "compiled" | "interpreted";
  items: ConversionItem[];
  /** Nodes the model still has to port; empty after a full run with a model. */
  needsModel: string[];
  /** Nodes nothing can port; the scene stays compiled while these exist. */
  needsManualPort: string[];
  modelCalls: number;
  usage: ModelUsage;
  model?: string | undefined;
};

export type ConversionResult = {
  scene: Scene;
  report: ConversionReport;
};
