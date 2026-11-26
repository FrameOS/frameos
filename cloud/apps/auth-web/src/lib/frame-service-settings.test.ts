import { describe, expect, it } from "vitest";
import type { ServiceKeysScene } from "../../../../../frontend/src/utils/serviceKeys";
import {
  buildServiceSettingsPayload,
  canonicalJson,
  previewServiceKeysScene,
  serviceKeysScenesForAssignments,
  serviceSettingsResponseBody,
} from "./frame-service-settings";

// One runtime scene that declares `declared` and is granted the default of
// what `granted` covers (the older rule), optionally bound with `keys`.
function scene(
  id: string,
  declared: string[],
  granted: string[] = declared,
  keys?: Record<string, string | null>,
): ServiceKeysScene {
  return { declared, id, legacyGranted: granted, ...(keys ? { keys } : {}) };
}

describe("buildServiceSettingsPayload", () => {
  const stored = {
    homeAssistant: { accessToken: "ha-token", url: "https://ha.local" },
    openAI: { apiKey: "openai-key", backendApiKey: "plane-only" },
    serviceCredentials: {
      k_work00000001: { name: "Work", service: "openAI", values: { apiKey: "work-key" } },
    },
    unsplash: { accessKey: "unsplash-key" },
  };

  it("sends only what the scenes were granted", () => {
    const payload = buildServiceSettingsPayload([scene("photos", ["unsplash"])], stored);
    expect(payload.groups).toEqual(["unsplash"]);
    expect(payload.settings).toEqual({ unsplash: { accessKey: "unsplash-key" } });
    expect(payload.serviceKeys.scenes).toEqual({ photos: { unsplash: "unsplash" } });
    expect(payload.serviceKeys.keys).toEqual({
      unsplash: { service: "unsplash", values: { accessKey: "unsplash-key" } },
    });
  });

  it("names a declared but refused service for its scene, and sends no key for it", () => {
    const payload = buildServiceSettingsPayload([scene("store-art", ["unsplash", "openAI"], ["unsplash"])], stored);
    expect(payload.groups).toEqual(["unsplash"]);
    expect(payload.settings).not.toHaveProperty("openAI");
    expect(payload.serviceKeys.scenes["store-art"]).toEqual({ openAI: null, unsplash: "unsplash" });
    expect(payload.serviceKeys.keys).not.toHaveProperty("openAI");
  });

  it("keeps a store scene refused while an own scene on the same frame uses the key", () => {
    // The hole this closes: the frame used to be sent the union, and every
    // scene whose app declared openAI read it.
    const payload = buildServiceSettingsPayload(
      [scene("art", ["openAI"]), scene("store-art", ["openAI"], [])],
      stored,
    );
    expect(payload.serviceKeys.scenes).toEqual({ art: { openAI: "openAI" }, "store-art": { openAI: null } });
    // Older runtimes still get the one frame-wide copy.
    expect(payload.settings).toEqual({ openAI: { apiKey: "openai-key" } });
  });

  it("sends a named key to the one scene bound to it", () => {
    const payload = buildServiceSettingsPayload(
      [scene("art", ["openAI"]), scene("work-art", ["openAI"], [], { openAI: "k_work00000001" })],
      stored,
    );
    expect(payload.serviceKeys.scenes).toEqual({ art: { openAI: "openAI" }, "work-art": { openAI: "k_work00000001" } });
    expect(payload.serviceKeys.keys.k_work00000001).toEqual({ service: "openAI", values: { apiKey: "work-key" } });
    expect(payload.settings.openAI).toEqual({ apiKey: "openai-key" });
  });

  it("never sends the plane's own fields of a group", () => {
    const payload = buildServiceSettingsPayload([scene("art", ["openAI"])], stored);
    expect(JSON.stringify(payload)).not.toContain("plane-only");
  });

  it("drops fields the device may not receive", () => {
    const payload = buildServiceSettingsPayload([scene("ha", ["homeAssistant"])], {
      homeAssistant: {
        accessToken: "ha-token",
        // Hand-inserted, as a stray DB row or a future account field would be.
        mqttPassword: "nope",
        url: "https://ha.local",
      },
    });
    expect(payload.settings.homeAssistant).toEqual({ accessToken: "ha-token", url: "https://ha.local" });
  });

  it("delivers a service the registry does not know, every string field of it", () => {
    const payload = buildServiceSettingsPayload([scene("weather", ["acmeWeather"])], {
      acmeWeather: { apiKey: "acme-1", region: "eu" },
    });
    expect(payload.groups).toEqual(["acmeWeather"]);
    expect(payload.serviceKeys.keys.acmeWeather).toEqual({
      service: "acmeWeather",
      values: { apiKey: "acme-1", region: "eu" },
    });
    expect(payload.serviceKeys.services.acmeWeather?.title).toBe("acmeWeather");
  });

  it("treats an empty string as not configured", () => {
    const payload = buildServiceSettingsPayload([scene("x", ["unsplash", "openAI"])], {
      openAI: { apiKey: "openai-key" },
      unsplash: { accessKey: "" },
    });
    expect(payload.settings).toEqual({ openAI: { apiKey: "openai-key" } });
    // Still bound — the frame needs it, the account just has not set it.
    expect(payload.groups).toEqual(["openAI", "unsplash"]);
    expect(payload.serviceKeys.scenes.x).toEqual({ openAI: "openAI", unsplash: "unsplash" });
  });

  it("ignores names that are no service", () => {
    const payload = buildServiceSettingsPayload(
      [scene("x", ["unsplash", "ssh_keys", "buildEnvironment"])],
      { ...stored, ssh_keys: { keys: "secret" } },
    );
    expect(payload.groups).toEqual(["unsplash"]);
    expect(payload.settings).not.toHaveProperty("ssh_keys");
  });

  it("sends nothing for a frame whose scenes declare nothing", () => {
    expect(buildServiceSettingsPayload([], stored)).toEqual({
      groups: [],
      serviceKeys: { keys: {}, scenes: {}, services: {}, v: 1 },
      settings: {},
    });
  });
});

describe("serviceKeysScenesForAssignments", () => {
  it("lists each runtime scene that declares something, with the install's keys and grant", () => {
    expect(
      serviceKeysScenesForAssignments([
        {
          declaredSettingsGroups: ["openAI", "unsplash"],
          grantedSettingsGroups: ["unsplash"],
          sceneServices: { a: ["openAI"], b: ["unsplash"], c: [] },
          serviceKeys: { a: { openAI: "k_work00000001" } },
        },
      ]),
    ).toEqual([
      { declared: ["openAI"], id: "a", keys: { openAI: "k_work00000001" }, legacyGranted: ["unsplash"] },
      { declared: ["unsplash"], id: "b", legacyGranted: ["unsplash"] },
    ]);
  });

  it("reads a NULL grant as all the install declares, and keeps a re-ided single scene's keys", () => {
    expect(
      serviceKeysScenesForAssignments([
        {
          declaredSettingsGroups: ["openAI"],
          grantedSettingsGroups: null,
          sceneServices: { renamed: ["openAI"] },
          serviceKeys: { old: { openAI: null } },
        },
      ]),
    ).toEqual([{ declared: ["openAI"], id: "renamed", keys: { openAI: null }, legacyGranted: ["openAI"] }]);
  });

  it("lists nothing for a row never settled", () => {
    expect(
      serviceKeysScenesForAssignments([
        { declaredSettingsGroups: null, grantedSettingsGroups: null, sceneServices: null, serviceKeys: null },
      ]),
    ).toEqual([]);
  });
});

describe("previewServiceKeysScene", () => {
  const preview = {
    id: "preview-1",
    nodes: [
      {
        data: { keyword: "x", sources: { "config.json": JSON.stringify({ settings: ["unsplash"] }) } },
        type: "app",
      },
    ],
  };

  it("gives the account's own preview the defaults, a stranger's nothing", () => {
    expect(previewServiceKeysScene(preview, true)).toEqual({
      declared: ["unsplash"],
      id: "preview-1",
      legacyGranted: ["unsplash"],
    });
    expect(previewServiceKeysScene(preview, false)).toEqual({ declared: ["unsplash"], id: "preview-1", legacyGranted: [] });
    expect(previewServiceKeysScene({ id: "x", nodes: [] }, true)).toBeNull();
  });
});

describe("the response body and ETag", () => {
  it("is stable under key order", () => {
    const a = serviceSettingsResponseBody(
      buildServiceSettingsPayload([scene("x", ["unsplash", "openAI"])], {
        openAI: { apiKey: "o" },
        unsplash: { accessKey: "u" },
      }),
    );
    const b = serviceSettingsResponseBody(
      buildServiceSettingsPayload([scene("x", ["openAI", "unsplash"])], {
        unsplash: { accessKey: "u" },
        openAI: { apiKey: "o" },
      }),
    );
    expect(a.body).toBe(b.body);
    expect(a.etag).toBe(b.etag);
  });

  it("changes when any value changes", () => {
    const before = serviceSettingsResponseBody(
      buildServiceSettingsPayload([scene("x", ["unsplash"])], { unsplash: { accessKey: "u" } }),
    );
    const after = serviceSettingsResponseBody(
      buildServiceSettingsPayload([scene("x", ["unsplash"])], { unsplash: { accessKey: "u2" } }),
    );
    expect(after.etag).not.toBe(before.etag);
  });

  it("changes when a scene's binding changes", () => {
    const stored = {
      openAI: { apiKey: "o" },
      serviceCredentials: { k_work00000001: { name: "Work", service: "openAI", values: { apiKey: "o" } } },
    };
    const before = serviceSettingsResponseBody(buildServiceSettingsPayload([scene("x", ["openAI"])], stored));
    const after = serviceSettingsResponseBody(
      buildServiceSettingsPayload([scene("x", ["openAI"], [], { openAI: "k_work00000001" })], stored),
    );
    expect(after.etag).not.toBe(before.etag);
  });

  it("quotes the etag and sorts nested keys", () => {
    const { etag } = serviceSettingsResponseBody(buildServiceSettingsPayload([], {}));
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
