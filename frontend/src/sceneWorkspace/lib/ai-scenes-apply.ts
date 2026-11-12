import type { AiChatEvent } from "./ai-chat-client";

export type SceneJson = { id: string } & Record<string, unknown>;

export type AiScenesEvent = Extract<AiChatEvent, { type: "scenes" }>;

export type AiScenesApplyResult = {
  /** A NEW array identity, so the embedded editor re-initialises. */
  scenes: SceneJson[];
  /** The scene to select in the editor (the modified one, or the first new one). */
  selectedSceneId: string | null;
};

function withId(scene: Record<string, unknown>, fallbackId: string): SceneJson {
  return prepareForEditor({
    ...scene,
    id: typeof scene.id === "string" && scene.id ? scene.id : fallbackId,
  });
}

// AI scenes carry no layout. The diagram (reactflow) reads `position.x` of
// every node and crashes on undefined, so every node gets a position — the
// editor's own "not placed yet" sentinel (-9999,-9999), which makes it lay the
// scene out once the nodes have been measured; the autoArrangeOnLoad marker
// is what the workspace chat sets for the same purpose.
export function prepareForEditor(scene: SceneJson): SceneJson {
  const nodes = Array.isArray(scene.nodes)
    ? scene.nodes.map((node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) {
          return node;
        }
        const entry = node as Record<string, unknown>;
        const position = entry.position as { x?: unknown; y?: unknown } | undefined;
        if (position && typeof position.x === "number" && typeof position.y === "number") {
          return entry;
        }
        return { ...entry, position: { x: -9999, y: -9999 } };
      })
    : scene.nodes;
  const settings =
    scene.settings && typeof scene.settings === "object" && !Array.isArray(scene.settings)
      ? (scene.settings as Record<string, unknown>)
      : {};
  return { ...scene, nodes, settings: { ...settings, autoArrangeOnLoad: true } };
}

/** The untouched starter scene of the new-scene flow: one event node, nothing wired. */
export function isBlankStarter(scene: SceneJson): boolean {
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  const edges = Array.isArray(scene.edges) ? scene.edges : [];
  return nodes.length <= 1 && edges.length === 0;
}

/**
 * Applies a `scenes` stream event to the editor's scenes.
 *
 * - `modify_scene`: scenes[0] replaces the scene with the same id; when no
 *   scene carries that id (the AI changed it), it replaces the currently
 *   selected scene instead, and when there is nothing to replace it is
 *   appended.
 * - `build_scene`: the scenes are new — appended (fresh ids where they
 *   collide with existing ones) and the first is selected. When the editor
 *   holds nothing but the blank starter scene, the new scenes replace it.
 */
export function applyAiScenes(
  current: SceneJson[],
  event: AiScenesEvent,
  selectedSceneId: string | null,
): AiScenesApplyResult {
  const incoming = event.scenes.filter(
    (scene): scene is Record<string, unknown> =>
      Boolean(scene) && typeof scene === "object" && !Array.isArray(scene),
  );
  if (incoming.length === 0) {
    return { scenes: [...current], selectedSceneId };
  }

  if (event.tool === "modify_scene") {
    const replacement = withId(incoming[0]!, selectedSceneId ?? crypto.randomUUID());
    let index = current.findIndex((scene) => scene.id === replacement.id);
    if (index === -1 && selectedSceneId) {
      index = current.findIndex((scene) => scene.id === selectedSceneId);
    }
    const next = [...current];
    if (index === -1) {
      next.push(replacement);
    } else {
      next[index] = replacement;
    }
    return { scenes: next, selectedSceneId: replacement.id };
  }

  const base = current.length === 1 && current[0] && isBlankStarter(current[0]) ? [] : current;
  const taken = new Set(base.map((scene) => scene.id));
  const added: SceneJson[] = [];
  for (const scene of incoming) {
    let candidate = withId(scene, crypto.randomUUID());
    if (taken.has(candidate.id)) {
      candidate = { ...candidate, id: crypto.randomUUID() };
    }
    taken.add(candidate.id);
    added.push(candidate);
  }
  return {
    scenes: [...base, ...added],
    selectedSceneId: added[0]?.id ?? selectedSceneId,
  };
}

/** A minimal blank scene for the "new scene" flow: one render event, nothing else. */
export function blankScene(name = "New scene"): SceneJson {
  return {
    id: crypto.randomUUID(),
    name,
    nodes: [
      {
        id: crypto.randomUUID(),
        type: "event",
        position: { x: 0, y: 0 },
        data: { keyword: "render" },
      },
    ],
    edges: [],
    fields: [],
    settings: { execution: "interpreted" },
  };
}
