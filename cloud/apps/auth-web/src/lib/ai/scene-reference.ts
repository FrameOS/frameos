// What anyone writing a scene looks up, as the cloud's API serves it to the
// MCP server (scene_guide, apps_list, app_source_get): the scene guide
// (docs/scene-guide.md) and the app catalog the scene AI uses. The backend
// answers the same three with the same shapes (backend/app/api/apps.py).

import { appCatalog, searchApps, type AiAppConfig } from "./context";
import { SCENE_GUIDE, SCENE_GUIDE_SECTIONS } from "./scene-guide.gen";

const fieldKeys = ["name", "type", "label", "required", "value", "options"] as const;

export type SceneGuideReply = {
  guide: string;
  sections: { id: string; title: string }[];
};

/** The whole guide, or one `## ` section by id; undefined for an unknown id. */
export function sceneGuide(section?: string | null): SceneGuideReply | undefined {
  const sections = SCENE_GUIDE_SECTIONS.map(({ id, title }) => ({ id, title }));
  if (!section) {
    return { guide: SCENE_GUIDE, sections };
  }
  const found = SCENE_GUIDE_SECTIONS.find((entry) => entry.id === section);
  return found ? { guide: found.text, sections } : undefined;
}

export function sceneGuideSectionIds(): string[] {
  return SCENE_GUIDE_SECTIONS.map((entry) => entry.id);
}

function appRow(app: AiAppConfig) {
  return {
    category: app.category,
    description: app.description,
    fields: (Array.isArray(app.fields) ? app.fields : [])
      .filter((field): field is Record<string, unknown> => !!field && typeof field === "object" && "name" in field)
      .map((field) => Object.fromEntries(fieldKeys.filter((key) => key in field).map((key) => [key, field[key]]))),
    keyword: app.keyword,
    name: app.name,
    output: app.output,
  };
}

/** The catalog, optionally narrowed by a search over keyword, name, description and category. */
export function appRows(search?: string | null, category?: string | null) {
  const apps = searchApps(search ?? undefined, category ?? undefined).map(appRow);
  return { apps, count: apps.length };
}

/** One app's files: a repo JS app's sources, or a built-in app's config.json. */
export function appSourceFiles(keyword: string): Record<string, string> | undefined {
  const app = appCatalog()[keyword];
  if (!app) {
    return undefined;
  }
  if (app.sources && Object.keys(app.sources).length > 0) {
    return { ...app.sources };
  }
  const { keyword: _keyword, sources: _sources, ...config } = app;
  return { "config.json": JSON.stringify(config, null, 2) };
}
