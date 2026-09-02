import { describe, expect, it } from "vitest";
import { storableAccountSettingsFields } from "./account-settings";
import {
  buildServiceSettingsPayload,
  canonicalJson,
  deviceDeliverableFields,
  serviceSettingsResponseBody,
} from "./frame-service-settings";

describe("deviceDeliverableFields", () => {
  it("is a subset of what an account may store", () => {
    // A device must never receive more of a group than the account stores,
    // and this list exists precisely so that adding, say, Home Assistant MQTT
    // credentials to the account form does not silently ship them to frames.
    for (const [group, fields] of deviceDeliverableFields) {
      const storable = storableAccountSettingsFields.get(group);
      expect(storable, `${group} is not a storable account group`).toBeDefined();
      for (const field of fields) {
        expect(
          storable?.has(field),
          `${group}.${field} is deliverable but not storable`,
        ).toBe(true);
      }
    }
  });

  it("keeps Home Assistant to url + token", () => {
    expect([...(deviceDeliverableFields.get("homeAssistant") ?? [])].sort()).toEqual([
      "accessToken",
      "url",
    ]);
  });
});

describe("buildServiceSettingsPayload", () => {
  const stored = {
    unsplash: { accessKey: "unsplash-key" },
    openAI: { apiKey: "openai-key" },
    homeAssistant: { url: "https://ha.local", accessToken: "ha-token" },
  };

  it("sends only the groups the owner granted", () => {
    const payload = buildServiceSettingsPayload(["unsplash"], stored);
    expect(payload.groups).toEqual(["unsplash"]);
    expect(payload.settings).toEqual({ unsplash: { accessKey: "unsplash-key" } });
  });

  it("never mentions a group a scene declared but was not granted", () => {
    // The caller passes the GRANTED union (frames.service_setting_groups), so
    // a scene that declares openAI without a grant leaves no trace here — not
    // in settings, not in groups (which the device reads as "cloud-owned").
    const granted = ["unsplash"];
    const declaredByScene = ["unsplash", "openAI"];
    const payload = buildServiceSettingsPayload(granted, stored);
    expect(declaredByScene).toContain("openAI");
    expect(payload.groups).not.toContain("openAI");
    expect(payload.settings).not.toHaveProperty("openAI");
  });

  it("lists a declared group with no stored key, but sends no settings for it", () => {
    // groups is what the UI shows as "this frame needs"; settings is what
    // exists. A declared-but-unset group must not appear as {}.
    const payload = buildServiceSettingsPayload(["unsplash", "immich"], stored);
    expect(payload.groups).toEqual(["immich", "unsplash"]);
    expect(payload.settings).not.toHaveProperty("immich");
  });

  it("drops fields the device may not receive", () => {
    const payload = buildServiceSettingsPayload(["homeAssistant"], {
      homeAssistant: {
        url: "https://ha.local",
        accessToken: "ha-token",
        // Hand-inserted, as a stray DB row or a future account field would be.
        mqttPassword: "nope",
      },
    });
    expect(payload.settings.homeAssistant).toEqual({
      url: "https://ha.local",
      accessToken: "ha-token",
    });
  });

  it("treats an empty string as not configured", () => {
    const payload = buildServiceSettingsPayload(["unsplash", "openAI"], {
      unsplash: { accessKey: "" },
      openAI: { apiKey: "openai-key" },
    });
    expect(payload.settings).toEqual({ openAI: { apiKey: "openai-key" } });
    // Still declared — the frame needs it, the account just has not set it.
    expect(payload.groups).toEqual(["openAI", "unsplash"]);
  });

  it("ignores groups no device can receive, and dedupes", () => {
    const payload = buildServiceSettingsPayload(
      ["unsplash", "unsplash", "ssh_keys", "buildEnvironment"],
      { ...stored, ssh_keys: { keys: "secret" } } as never,
    );
    expect(payload.groups).toEqual(["unsplash"]);
    expect(payload.settings).not.toHaveProperty("ssh_keys");
  });

  it("sends nothing for a frame whose scenes declare nothing", () => {
    expect(buildServiceSettingsPayload([], stored)).toEqual({
      settings: {},
      groups: [],
    });
  });
});

describe("the response body and ETag", () => {
  it("is stable under key order", () => {
    const a = serviceSettingsResponseBody(
      buildServiceSettingsPayload(["unsplash", "openAI"], {
        unsplash: { accessKey: "u" },
        openAI: { apiKey: "o" },
      }),
    );
    const b = serviceSettingsResponseBody(
      buildServiceSettingsPayload(["openAI", "unsplash"], {
        openAI: { apiKey: "o" },
        unsplash: { accessKey: "u" },
      }),
    );
    expect(a.body).toBe(b.body);
    expect(a.etag).toBe(b.etag);
  });

  it("changes when any value changes", () => {
    const before = serviceSettingsResponseBody(
      buildServiceSettingsPayload(["unsplash"], { unsplash: { accessKey: "u" } }),
    );
    const after = serviceSettingsResponseBody(
      buildServiceSettingsPayload(["unsplash"], { unsplash: { accessKey: "u2" } }),
    );
    expect(after.etag).not.toBe(before.etag);
  });

  it("changes when a declared-but-unset group appears", () => {
    // The device clears groups absent from `settings`, so `groups` alone
    // changing is still a change it must see.
    const before = serviceSettingsResponseBody(
      buildServiceSettingsPayload(["unsplash"], { unsplash: { accessKey: "u" } }),
    );
    const after = serviceSettingsResponseBody(
      buildServiceSettingsPayload(["unsplash", "immich"], {
        unsplash: { accessKey: "u" },
      }),
    );
    expect(after.etag).not.toBe(before.etag);
  });

  it("quotes the etag and sorts nested keys", () => {
    const { etag } = serviceSettingsResponseBody({ settings: {}, groups: [] });
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });
});
