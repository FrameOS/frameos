import { describe, expect, it } from "vitest";
import {
  filterAccountSettings,
  maxAccountSettingValueLength,
  storableAccountSettingsFields,
} from "./account-settings";

describe("storableAccountSettingsFields", () => {
  it("is exactly the service groups the preview settings define", () => {
    // Derived from preview-settings.ts on purpose: what the wasm preview can
    // consume is what an account may persist. If this list changes, the
    // settings page (allowedGlobalSettingsSections) probably needs the
    // matching section too.
    const fields = Object.fromEntries(
      [...storableAccountSettingsFields.entries()].map(([group, names]) => [
        group,
        [...names].sort(),
      ]),
    );
    expect(fields).toEqual({
      frameOS: ["apiKey"],
      github: ["api_key"],
      homeAssistant: ["accessToken", "url"],
      immich: ["apiKey", "url"],
      // backendApiKey: the account's own AI-chat key — storable, not a
      // preview field, never device-deliverable.
      openAI: ["apiKey", "backendApiKey"],
      unsplash: ["accessKey"],
    });
  });
});

describe("filterAccountSettings", () => {
  it("keeps storable groups and silently drops the form's backend-only ones", () => {
    // The shared settings form posts its WHOLE form object; refusing the
    // backend-only scaffolding would break Save on the cloud outright.
    const { error, settings } = filterAccountSettings({
      buildEnvironment: { provider: "docker" },
      defaults: { timezone: "UTC", wifiSSID: "" },
      openAI: { apiKey: "sk-test" },
      personal: { favouriteTemplateIds: ["a"] },
      posthog: { backendApiKey: "phc" },
      ssh_keys: { keys: [] },
      unsplash: { accessKey: "u-key" },
    });
    expect(error).toBeUndefined();
    expect(settings).toEqual({
      openAI: { apiKey: "sk-test" },
      unsplash: { accessKey: "u-key" },
    });
  });

  it("drops backend-only fields inside a storable group", () => {
    const { settings } = filterAccountSettings({
      homeAssistant: {
        accessToken: "token",
        mqttUsername: "mqtt",
        syncEnabled: true,
        url: "http://ha.local:8123",
      },
      openAI: { apiKey: "sk", backendApiKey: "sk-backend", model: "gpt-5.5" },
    });
    expect(settings).toEqual({
      homeAssistant: { accessToken: "token", url: "http://ha.local:8123" },
      openAI: { apiKey: "sk", backendApiKey: "sk-backend" },
    });
  });

  it("keeps an explicitly empty group (replace-wholesale clears its fields)", () => {
    expect(filterAccountSettings({ github: {} }).settings).toEqual({
      github: {},
    });
  });

  it("refuses bad data in a storable field rather than half-applying", () => {
    expect(filterAccountSettings({ openAI: "sk-test" }).error).toBe(
      "invalid_settings",
    );
    expect(filterAccountSettings({ openAI: { apiKey: 42 } }).error).toBe(
      "invalid_settings",
    );
    expect(
      filterAccountSettings({
        openAI: { apiKey: "x".repeat(maxAccountSettingValueLength + 1) },
      }).error,
    ).toBe("settings_value_too_large");
  });

  it("never resolves groups or fields through Object.prototype", () => {
    for (const key of ["toString", "__proto__", "constructor", "valueOf"]) {
      expect(filterAccountSettings({ [key]: { x: "y" } }).settings).toEqual({});
      const inGroup = filterAccountSettings({ openAI: { [key]: "y" } });
      expect(inGroup.settings).toEqual({ openAI: {} });
    }
  });
});
