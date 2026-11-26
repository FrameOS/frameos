// Which service keys a scene's apps need to actually render — so the live
// preview can ask for them instead of drawing "please provide an API key".
// The services are the registry's (repo/services.json, docs/service-keys.md)
// and any an app defines for itself; the `settings` lists in the apps'
// config.json files say which.
// Keys TYPED into the preview stay in the browser: they go straight into the
// wasm runtime and out with its requests, never to our server — except for
// hosts that need the CORS fallback proxy (/api/store/preview-proxy), which
// forwards the app's request headers, `Authorization` included, to the host
// the app named and to nowhere else (guardedFetch drops credential headers
// before following a redirect to another origin; our own cookies are never
// forwarded). Keys SAVED on the account settings page persist server-side
// (account_settings) and seed the preview automatically.

import { keyedRepoAppSources } from "../../generated/keyedRepoApps";
import { SERVICE_REGISTRY } from "../../generated/services.gen";
import {
  type ServiceDefinition,
  appServiceDefinitions,
  isServiceId,
  serviceDefinition,
} from "../../utils/serviceKeys";

export type PreviewSettingsField = {
  label: string;
  path: [string, string];
  secret?: boolean;
};

export type PreviewSettingsGroup = {
  key: string;
  title: string;
  fields: PreviewSettingsField[];
  /** The service bills per request (OpenAI): the preview must not call it
   * without the user asking for that render. */
  paid?: boolean;
};

// The services the registry knows (repo/services.json, docs/service-keys.md),
// as the preview draws them. Also what the cloud's account-settings.ts
// derives the registered groups' storable fields from. A service the registry
// does not know is drawn by previewSettingsGroupFor from the scene's own
// app definitions.
//
// `paid` is the preview's own rule, not the registry's: OpenAI bills every
// render, so the preview waits for a click before calling it.
const PAID_SERVICES: ReadonlySet<string> = new Set(["openAI"]);

function groupOf(definition: ServiceDefinition): PreviewSettingsGroup {
  return {
    key: definition.id,
    title: definition.title,
    fields: definition.fields.map((field) => ({
      label: field.label,
      path: [definition.id, field.name] as [string, string],
      ...(field.secret ? { secret: true } : {}),
    })),
    ...(PAID_SERVICES.has(definition.id) ? { paid: true } : {}),
  };
}

export const previewSettingsGroups: Readonly<
  Record<string, PreviewSettingsGroup>
> = Object.fromEntries(
  Object.keys(SERVICE_REGISTRY).map((id) => [id, groupOf(serviceDefinition(id))]),
);

/** Any service's group: the registry's, else what the scene's apps define. */
export function previewSettingsGroupFor(
  id: string,
  appDefinitions?: Record<string, ServiceDefinition> | null,
): PreviewSettingsGroup {
  return previewSettingsGroups[id] ?? groupOf(serviceDefinition(id, appDefinitions));
}

// App keyword → settings groups, from the apps' config.json `settings` lists.
// Retired Nim apps (retired-apps.ts: data/immich, data/unsplash, …) stay
// listed: store versions saved before they were retired still name them, and
// a frame on firmware older than their JavaScript replacements is sent them.
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
function definitionsFromSources(sources?: AppSources): Record<string, ServiceDefinition> {
  const raw = sources?.["config.json"];
  if (typeof raw !== "string" || raw === "") {
    return {};
  }
  try {
    return appServiceDefinitions(JSON.parse(raw));
  } catch {
    return {};
  }
}

function settingsFromSources(sources?: AppSources): string[] {
  const raw = sources?.["config.json"];
  if (typeof raw !== "string" || raw === "") {
    return [];
  }
  try {
    const settings = (JSON.parse(raw) as { settings?: unknown })?.settings;
    return Array.isArray(settings) ? settings.filter(isServiceId) : [];
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
  const definitions: Record<string, ServiceDefinition> = {};
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
        for (const [id, definition] of Object.entries(definitionsFromSources(sources))) {
          definitions[id] ??= definition;
        }
      } else if (keyword) {
        for (const key of appSettings[keyword] ?? []) {
          keys.add(key);
        }
      }
    }
  }
  return [...keys]
    .sort()
    .map((key) => previewSettingsGroupFor(key, definitions));
}

// The pay-per-request services the given scenes call (see `paid` above). The
// live preview gates its rendering on these: a render is a real API call.
export function paidServicesForScenes(
  rawScenes: Record<string, unknown>[],
): PreviewSettingsGroup[] {
  return requiredSettingsForScenes(rawScenes).filter((group) => group.paid);
}

function configList(config: unknown, key: "settings" | "permissions"): string[] {
  const value = (config as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function parsedConfig(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Whether an app a scene carries is one of FrameOS's own repo apps with its
// code unchanged: every code file exactly the repo's, and a config.json that
// asks for no key and no permission the repo's does not. Labels, defaults and
// formatting may differ (the store writes `"permissions": []` where the repo
// leaves it out). Since the Immich app moved from Nim to a repo JS app every
// Immich scene carries its code, and the preview held all of them back as
// if a stranger had written it.
export function isUnchangedRepoApp(sources: AppSources | undefined): boolean {
  if (!sources) {
    return false;
  }
  const files = Object.entries(sources).filter(([name]) => name !== "config.json");
  if (files.length === 0) {
    return false;
  }
  return Object.values(keyedRepoAppSources).some((repo) => {
    if (!files.every(([name, content]) => repo[name] === content)) {
      return false;
    }
    const ours = parsedConfig(repo["config.json"]);
    const theirs = parsedConfig(sources["config.json"]);
    if (theirs === null) {
      return sources["config.json"] === undefined;
    }
    return (["settings", "permissions"] as const).every((key) => {
      const allowed = new Set(configList(ours, key));
      return configList(theirs, key).every((entry) => allowed.has(entry));
    });
  });
}

// Settings groups a scene claims through app sources it carries itself
// (a config.json under sources), as opposed to the stock apps' catalogue.
// Scene code is untrusted — a published scene can be anyone's — and an app
// that ships its own config.json decides which of the viewer's stored keys
// it may read. The stock apps are ours, and so is a repo app whose code the
// scene carries unchanged (isUnchangedRepoApp); anything else is not.
export function embeddedSourceSettingsForScenes(
  rawScenes: Record<string, unknown>[],
): PreviewSettingsGroup[] {
  const scenes = rawScenes as SceneJson[];
  const keys = new Set<string>();
  const definitions: Record<string, ServiceDefinition> = {};
  for (const scene of scenes) {
    for (const node of scene.nodes ?? []) {
      if (node.type !== "app") {
        continue;
      }
      const keyword = node.data?.keyword;
      const sources =
        node.data?.sources ??
        (keyword ? scene.apps?.[keyword]?.sources : undefined);
      if (isUnchangedRepoApp(sources)) {
        continue;
      }
      for (const key of settingsFromSources(sources)) {
        keys.add(key);
      }
      for (const [id, definition] of Object.entries(definitionsFromSources(sources))) {
        definitions[id] ??= definition;
      }
    }
  }
  return [...keys]
    .sort()
    .map((key) => previewSettingsGroupFor(key, definitions));
}

// What the live preview must wait for a click on before rendering: paid
// services (every render bills), and any service a scene's own bundled app
// code asks for (every render hands that code the viewer's stored key).
export function gatedServicesForScenes(
  rawScenes: Record<string, unknown>[],
): PreviewSettingsGroup[] {
  const paid = paidServicesForScenes(rawScenes);
  const embedded = embeddedSourceSettingsForScenes(rawScenes);
  const seen = new Set<string>();
  return [...paid, ...embedded].filter((group) => {
    if (seen.has(group.key)) {
      return false;
    }
    seen.add(group.key);
    return true;
  });
}
