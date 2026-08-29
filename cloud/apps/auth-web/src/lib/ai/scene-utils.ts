// Pure scene-JSON helpers for the AI chat: structural validation the agent
// loop runs locally (so bad payloads bounce back to the model as tool errors
// instead of costing another full generation round), plus the post-processing
// the editor expects. Ported from the previous ai-scene.ts, which ported them
// from the self-hosted backend's ai_scene.py.

export type JsonObject = Record<string, unknown>;

export function formatAiException(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message.trim() || error.name
      : String(error).trim() || "Error";
  if (raw.toLowerCase() === "not found") {
    return (
      "OpenAI returned Not Found. Check the configured OpenAI model name in Settings -> OpenAI " +
      "and make sure the API key has access to it."
    );
  }
  return raw;
}

// Structural validation of a {scenes: [...]} payload. Returns human-readable
// issues; empty array = valid.
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

// Every app node's keyword must exist — either in the server-side catalog or
// in the scene's own bundled `apps` map (interpreted scenes may carry their
// JS apps inline). The old pipeline skipped this check on the cloud entirely,
// which is how hallucinated keywords reached the editor.
export function validateAppKeywords(
  payload: JsonObject,
  knownKeywords: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  const scenes = Array.isArray(payload.scenes) ? payload.scenes : [];
  scenes.forEach((scene, index) => {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      return;
    }
    const entry = scene as JsonObject;
    const sceneApps =
      entry.apps && typeof entry.apps === "object" && !Array.isArray(entry.apps)
        ? new Set(Object.keys(entry.apps as JsonObject))
        : new Set<string>();
    const nodes = Array.isArray(entry.nodes) ? entry.nodes : [];
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        continue;
      }
      const nodeEntry = node as JsonObject;
      if (nodeEntry.type !== "app") {
        continue;
      }
      const data = (nodeEntry.data ?? {}) as JsonObject;
      const keyword = data.keyword;
      if (typeof keyword !== "string" || !keyword) {
        issues.push(`Scene ${index} has an app node without a keyword.`);
        continue;
      }
      // App nodes that bundle their own sources are self-contained.
      const hasInlineSources =
        data.sources &&
        typeof data.sources === "object" &&
        !Array.isArray(data.sources) &&
        Object.keys(data.sources as JsonObject).length > 0;
      if (!knownKeywords.has(keyword) && !sceneApps.has(keyword) && !hasInlineSources) {
        issues.push(
          `Scene ${index} uses unknown app keyword '${keyword}'. Use search_apps to find valid keywords.`,
        );
      }
    }
  });
  return issues;
}

// When one state node feeds several app nodes, clone it per app so the
// diagram routing stays legible. Mutates the payload in place.
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

// Repo JS apps (repo/apps/code/*) are templates, not runtime keywords: the
// frame only knows an app once its config + sources sit in the scene's own
// "apps" map under a short keyword (the Weather sample carries weatherIcons
// and weatherPanel that way, with "origin" naming the template). The catalog
// lists them under their repo path — which the model naturally uses — so
// bundle them at delivery instead of bouncing a scene the runtime would
// reject with "Unknown app keyword". Mutates in place; returns what it did.
export function bundleRepoApps(
  payload: JsonObject,
  catalog: Record<string, { keyword: string; sources?: Record<string, string>; [key: string]: unknown }>,
): string[] {
  const bundled: string[] = [];
  const scenes = Array.isArray(payload.scenes) ? payload.scenes : [];
  for (const scene of scenes) {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      continue;
    }
    const entry = scene as JsonObject;
    const nodes = Array.isArray(entry.nodes) ? entry.nodes : [];
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        continue;
      }
      const nodeEntry = node as JsonObject;
      const data = (nodeEntry.data ?? {}) as JsonObject;
      const keyword = data.keyword;
      if (nodeEntry.type !== "app" || typeof keyword !== "string" || !keyword.startsWith("repo/apps/")) {
        continue;
      }
      const template = catalog[keyword];
      if (!template?.sources || Object.keys(template.sources).length === 0) {
        continue;
      }
      const short = keyword.slice(keyword.lastIndexOf("/") + 1);
      const apps =
        entry.apps && typeof entry.apps === "object" && !Array.isArray(entry.apps)
          ? (entry.apps as JsonObject)
          : (entry.apps = {});
      if (!apps[short]) {
        const { keyword: _keyword, sources, ...config } = template;
        apps[short] = { ...config, origin: keyword, sources: { ...sources } };
      }
      data.keyword = short;
      nodeEntry.data = data;
      bundled.push(`${keyword} -> apps.${short}`);
    }
  }
  return bundled;
}
