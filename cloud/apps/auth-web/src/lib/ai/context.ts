// The AI chat's bundled knowledge: the app catalog, example scenes, docs and
// JS API reference emitted by scripts/generate-ai-context.mjs. Everything the
// tools serve from here is Nim-free by construction (the generator strips
// app.nim sources; docs are prose).
import aiContext from "../../generated/ai-context.json";

export type AiAppConfig = {
  keyword: string;
  name?: string;
  category?: string;
  description?: string;
  fields?: unknown[];
  output?: unknown[];
  settings?: string[];
  cache?: unknown;
  sources?: Record<string, string>;
};

export type AiExampleScene = {
  name: string;
  slug: string;
  description: string;
  summary: { nodeCount: number; edgeCount: number; appKeywords: string[] }[];
  scenes: unknown[];
};

export type AiDoc = {
  path: string;
  sections: { heading: string; content: string }[];
};

type AiContext = {
  apps: Record<string, AiAppConfig>;
  events: unknown[];
  jsTypeDeclarations: string;
  examples: AiExampleScene[];
  docs: AiDoc[];
};

const context = aiContext as unknown as AiContext;

export function appCatalog(): Record<string, AiAppConfig> {
  return context.apps;
}

export function knownAppKeywords(): ReadonlySet<string> {
  return new Set(Object.keys(context.apps));
}

export function sceneEvents(): unknown[] {
  return context.events;
}

export function jsTypeDeclarations(): string {
  return context.jsTypeDeclarations;
}

export function exampleScenes(): AiExampleScene[] {
  return context.examples;
}

export function docs(): AiDoc[] {
  return context.docs;
}

// --- lightweight token-overlap search (no embeddings; the corpus is small
// and bundled, and a deterministic scorer keeps results reproducible) ---

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

function scoreTokens(queryTokens: string[], haystack: string): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const haystackLower = haystack.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystackLower.includes(token)) {
      score += 1;
    }
  }
  return score;
}

export function searchApps(query?: string, category?: string): AiAppConfig[] {
  const queryTokens = tokenize(query ?? "");
  const apps = Object.values(context.apps).filter(
    (app) => !category || app.category === category,
  );
  if (queryTokens.length === 0) {
    return apps;
  }
  return apps
    .map((app) => ({
      app,
      score: scoreTokens(
        queryTokens,
        `${app.keyword} ${app.name ?? ""} ${app.description ?? ""} ${app.category ?? ""}`,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.app);
}

export function getApp(keyword: string): AiAppConfig | undefined {
  return context.apps[keyword];
}

export function searchExamples(query?: string): AiExampleScene[] {
  const queryTokens = tokenize(query ?? "");
  if (queryTokens.length === 0) {
    return context.examples;
  }
  return context.examples
    .map((example) => ({
      example,
      score: scoreTokens(
        queryTokens,
        `${example.name} ${example.description} ${example.summary
          .flatMap((scene) => scene.appKeywords)
          .join(" ")}`,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.example);
}

export function getExample(slug: string): AiExampleScene | undefined {
  return context.examples.find(
    (example) => example.slug === slug || example.name === slug,
  );
}

export type DocSectionHit = {
  path: string;
  heading: string;
  excerpt: string;
  score: number;
};

export function searchDocs(query: string, limit = 8): DocSectionHit[] {
  const queryTokens = tokenize(query);
  const hits: DocSectionHit[] = [];
  for (const doc of context.docs) {
    for (const section of doc.sections) {
      const score =
        scoreTokens(queryTokens, section.heading) * 3 +
        scoreTokens(queryTokens, section.content);
      if (score > 0) {
        hits.push({
          excerpt: section.content.slice(0, 300),
          heading: section.heading,
          path: doc.path,
          score,
        });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function readDoc(path: string, heading?: string): string | undefined {
  const doc = context.docs.find((entry) => entry.path === path);
  if (!doc) {
    return undefined;
  }
  if (heading) {
    const section = doc.sections.find(
      (entry) => entry.heading.toLowerCase() === heading.toLowerCase(),
    );
    if (section) {
      return section.content;
    }
  }
  return doc.sections.map((section) => section.content).join("\n\n");
}
