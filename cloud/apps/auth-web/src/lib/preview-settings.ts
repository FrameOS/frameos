// Which frame settings a scene's apps need to actually render — so the live
// preview can ask for them instead of drawing "please provide an API key".
// Mirrors frameos' settings groups (frontend/src/scenes/frame/panels/
// secretSettings.ts) and the `settings` lists in the apps' config.json files.
// Keys TYPED into the preview stay in the browser: they go straight into the
// wasm runtime and out with its requests, never to our server (except hosts
// that need the CORS fallback proxy, which forwards headers verbatim). Keys
// SAVED on the account settings page persist server-side (account_settings)
// and seed the preview automatically.

export type PreviewSettingsField = {
  label: string;
  path: [string, string];
  secret?: boolean;
};

export type PreviewSettingsGroup = {
  key: string;
  title: string;
  fields: PreviewSettingsField[];
};

// Also the source of truth for which settings an ACCOUNT may persist
// (account-settings.ts derives its allow-list from these groups) — one list,
// two consumers, so the preview and the stored settings cannot drift.
export const previewSettingsGroups: Readonly<
  Record<string, PreviewSettingsGroup>
> = {
  frameOS: {
    key: "frameOS",
    title: "FrameOS Gallery",
    fields: [{ label: "API key", path: ["frameOS", "apiKey"], secret: true }],
  },
  github: {
    key: "github",
    title: "GitHub",
    fields: [{ label: "API key", path: ["github", "api_key"], secret: true }],
  },
  homeAssistant: {
    key: "homeAssistant",
    title: "Home Assistant",
    fields: [
      { label: "Server URL", path: ["homeAssistant", "url"] },
      {
        label: "Access token",
        path: ["homeAssistant", "accessToken"],
        secret: true,
      },
    ],
  },
  immich: {
    key: "immich",
    title: "Immich",
    fields: [
      { label: "Server URL", path: ["immich", "url"] },
      { label: "API key", path: ["immich", "apiKey"], secret: true },
    ],
  },
  openAI: {
    key: "openAI",
    title: "OpenAI",
    fields: [{ label: "API key", path: ["openAI", "apiKey"], secret: true }],
  },
  unsplash: {
    key: "unsplash",
    title: "Unsplash",
    fields: [
      { label: "Access key", path: ["unsplash", "accessKey"], secret: true },
    ],
  },
};

// App keyword → settings groups, from the apps' config.json `settings` lists.
const appSettings: Record<string, string[]> = {
  "data/frameOSGallery": ["frameOS"],
  "data/haSensor": ["homeAssistant"],
  "data/immich": ["immich"],
  "data/openaiImage": ["openAI"],
  "data/openaiText": ["openAI"],
  "data/unsplash": ["unsplash"],
};

type AppSources = Record<string, string>;

type SceneJson = {
  nodes?: {
    type?: string;
    data?: { keyword?: string; sources?: AppSources };
  }[];
  apps?: Record<string, { sources?: AppSources }>;
};

// A scene can carry an edited copy of an app's own config.json, as a JSON
// STRING under sources["config.json"] — on the node, or on the scene's apps
// map. Reading `.config.settings` (an object that never exists in real scene
// JSON) silently missed every custom app.
function settingsFromSources(sources?: AppSources): string[] {
  const raw = sources?.["config.json"];
  if (typeof raw !== "string" || raw === "") {
    return [];
  }
  try {
    const settings = (JSON.parse(raw) as { settings?: unknown })?.settings;
    return Array.isArray(settings)
      ? settings.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    // A scene with unparseable sources must not break the settings form.
    return [];
  }
}

// The settings groups the given scenes need, in a stable order. Accepts the
// raw parsed scenes.json (shape narrowed internally).
//
// Mirrors get_frame_json in backend/app/models/frame.py: only `app` nodes
// count, embedded sources are AUTHORITATIVE when present (an edited app that
// dropped a dependency must not keep it), and the keyword table is the
// fallback for stock apps. The cloud has no app catalog to read config.json
// files from — appSettings above is that catalog, kept honest by a drift test.
export function requiredSettingsForScenes(
  rawScenes: Record<string, unknown>[],
): PreviewSettingsGroup[] {
  const scenes = rawScenes as SceneJson[];
  const keys = new Set<string>();
  for (const scene of scenes) {
    for (const node of scene.nodes ?? []) {
      if (node.type !== "app") {
        continue;
      }
      const keyword = node.data?.keyword;
      const sources =
        node.data?.sources ??
        (keyword ? scene.apps?.[keyword]?.sources : undefined);
      if (sources && Object.keys(sources).length > 0) {
        for (const key of settingsFromSources(sources)) {
          keys.add(key);
        }
      } else if (keyword) {
        for (const key of appSettings[keyword] ?? []) {
          keys.add(key);
        }
      }
    }
  }
  return Object.values(previewSettingsGroups).filter((group) =>
    keys.has(group.key),
  );
}
