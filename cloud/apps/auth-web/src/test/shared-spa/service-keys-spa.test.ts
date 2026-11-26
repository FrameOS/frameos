// The SPA's half of service keys (docs/service-keys.md): an app's code fills
// its config.json `settings` on save, an installed scene's key choices, and
// the grant checkboxes keeping those choices honest. The rules both planes
// share are pinned by service-keys-fixtures.test.ts.

import { describe, expect, it } from "vitest";
import { detectServiceReads, withAppServiceReads } from "../../../../../../frontend/src/utils/sceneAccess";
import {
  defaultKeyBindings,
  legacyGrantedServices,
  sceneKeyBindings,
  serviceKeysFollowingGrant,
} from "../../../../../../frontend/src/utils/sceneKeyBindings";
import { withoutSceneOrigin } from "../../../../../../frontend/src/utils/cloudFrameScenesSave";
import { keyRefLabel, withSceneKeys, withoutSceneKeys } from "../../../../../../frontend/src/utils/serviceKeys";
import type { FrameScene } from "../../../../../../frontend/src/types";

function sceneWithApp(sources: Record<string, string>): Record<string, unknown> {
  return {
    id: "s",
    name: "S",
    nodes: [{ id: "1", type: "app", data: { keyword: "custom" } }],
    edges: [],
    apps: { custom: { sources } },
  };
}

function configOf(scene: unknown): Record<string, unknown> {
  const apps = (scene as { apps: Record<string, { sources: Record<string, string> }> }).apps;
  return JSON.parse(apps["custom"]?.sources["config.json"] ?? "{}") as Record<string, unknown>;
}

describe("an app's settings follow its code", () => {
  it("reads literal getSetting and secret calls, not tests", () => {
    expect(
      detectServiceReads({
        "app.ts": `const a = frameos.getSetting('openAI', 'apiKey')\nconst b = frameos.secret("acmeWeather", "apiKey")\nframeos.getSetting('acmeWeather', 'region')\nframeos.getSetting(name)`,
        "app.test.ts": `frameos.getSetting('github', 'api_key')`,
        "notes.md": `frameos.getSetting('unsplash', 'accessKey')`,
      }),
    ).toEqual({ openAI: ["apiKey"], acmeWeather: ["apiKey", "region"] });
  });

  it("adds what the code reads, with a stub for a service the registry lacks", () => {
    const scene = sceneWithApp({
      "app.ts": `frameos.getSetting('openAI', 'apiKey'); frameos.secret('acmeWeather', 'apiKey')`,
      "config.json": JSON.stringify({ name: "x", settings: ["unsplash"], permissions: [] }, null, 2),
    });
    const config = configOf(withAppServiceReads(scene));
    expect(config.settings).toEqual(["unsplash", "acmeWeather", "openAI"]);
    expect(config.services).toEqual({ acmeWeather: { title: "acmeWeather", fields: [{ name: "apiKey", label: "apiKey" }] } });
    expect(Object.keys(config)).toEqual(["name", "settings", "services", "permissions"]);
  });

  it("never removes a name, never overwrites an app's own definition, and changes nothing when nothing is new", () => {
    const own = { acmeWeather: { title: "Acme Weather", fields: [{ name: "apiKey", label: "API key" }] } };
    const scene = sceneWithApp({
      "app.ts": `frameos.getSetting('acmeWeather', 'apiKey')`,
      "config.json": JSON.stringify({ settings: ["acmeWeather", "openAI"], services: own }),
    });
    expect(withAppServiceReads(scene)).toBe(scene);
  });

  it("leaves a config.json that does not parse alone", () => {
    const scene = sceneWithApp({ "app.ts": `frameos.getSetting('openAI', 'apiKey')`, "config.json": "{ nope" });
    expect(withAppServiceReads(scene)).toBe(scene);
  });
});

const openAiApp = {
  sources: {
    "app.ts": "frameos.getSetting('openAI', 'apiKey')",
    "config.json": JSON.stringify({ settings: ["openAI"] }),
  },
};

function installed(extra: Partial<FrameScene> = {}): FrameScene {
  return {
    id: "rt-1",
    name: "Art",
    nodes: [{ id: "1", type: "app", data: { keyword: "custom" } }],
    edges: [],
    apps: { custom: openAiApp },
    ...extra,
  } as unknown as FrameScene;
}

describe("which key an installed scene gets", () => {
  const credentials = { k_work00000001: { service: "openAI", name: "Work", values: { apiKey: "sk" } } };

  it("a backend's own scene: the default of what it declares", () => {
    expect(sceneKeyBindings(installed(), ["openAI"], {}, credentials, { cloud: false })).toEqual({ openAI: "default" });
  });

  it("a backend's store scene: the frame's older grant, until the install chooses", () => {
    const store = installed({ origin: { storeSceneId: "store-1" } });
    expect(sceneKeyBindings(store, ["openAI"], { service_setting_groups: [] }, credentials, { cloud: false })).toEqual({
      openAI: null,
    });
    expect(
      sceneKeyBindings(store, ["openAI"], { service_setting_groups: ["openAI"] }, credentials, { cloud: false }),
    ).toEqual({ openAI: "default" });
    const chosen = withSceneKeys(store, { openAI: "k_work00000001" });
    expect(sceneKeyBindings(chosen, ["openAI"], { service_setting_groups: [] }, credentials, { cloud: false })).toEqual({
      openAI: "k_work00000001",
    });
  });

  it("a cloud scene: the assignment's grant, everything for one not saved yet", () => {
    expect(legacyGrantedServices(installed(), ["openAI"], {}, { cloud: true, source: null })).toEqual(["openAI"]);
    expect(
      legacyGrantedServices(installed(), ["openAI"], {}, {
        cloud: true,
        source: { scene_id: "a", granted_settings_groups: [] },
      }),
    ).toEqual([]);
  });

  it("labels: the default, a named key, a refused or removed one", () => {
    expect(keyRefLabel("default", credentials)).toBe("Default key");
    expect(keyRefLabel("k_work00000001", credentials)).toBe("Work");
    expect(keyRefLabel(null, credentials)).toBe("Not given");
    expect(keyRefLabel("k_gone00000001", credentials)).toBe("Removed key");
  });

  it("an install gives a new scene the defaults of what it declares", () => {
    expect(defaultKeyBindings(["unsplash", "openAI"])).toEqual({ openAI: "default", unsplash: "default" });
  });

  it("the choices are the install's: stripped before any publish or template", () => {
    const chosen = withSceneKeys(installed(), { openAI: null });
    expect(chosen.keys).toEqual({ openAI: null });
    expect(withoutSceneOrigin(chosen)).not.toHaveProperty("keys");
    expect(withoutSceneKeys(chosen)).not.toHaveProperty("keys");
    expect(withSceneKeys(chosen, {})).not.toHaveProperty("keys");
  });
});

describe("the cloud's grant checkboxes keep the choices honest", () => {
  it("a service taken away is refused, one given back gets the default", () => {
    expect(
      serviceKeysFollowingGrant(
        { "rt-1": { openAI: "k_work00000001", unsplash: null }, "rt-2": { openAI: "default" } },
        ["unsplash"],
      ),
    ).toEqual({ "rt-1": { openAI: null, unsplash: "default" }, "rt-2": { openAI: null } });
    expect(serviceKeysFollowingGrant(undefined, ["openAI"])).toBeUndefined();
  });
});
