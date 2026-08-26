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
      // backendApiKey / chatModel / chatReasoningEffort: the account's own
      // AI-chat key + tuning — storable, not preview fields, never
      // device-deliverable.
      openAI: ["apiKey", "backendApiKey", "chatModel", "chatReasoningEffort"],
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
      // SSH public keys are the one non-service group the cloud keeps (for
      // the SD card builder); an empty list is a valid "no keys" save.
      ssh_keys: { keys: [] },
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
      openAI: {
        apiKey: "sk",
        backendApiKey: "sk-backend",
        chatModel: "gpt-5.5",
        model: "gpt-5.5",
      },
    });
    expect(settings).toEqual({
      homeAssistant: { accessToken: "token", url: "http://ha.local:8123" },
      openAI: { apiKey: "sk", backendApiKey: "sk-backend", chatModel: "gpt-5.5" },
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

  it("stores the account's SSH public keys, and never a private half", () => {
    const ed25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGJ4ZmFrZWtleWZha2VrZXlmYWtla2V5ZmFrZWtleQ marius@laptop";
    const { error, settings } = filterAccountSettings({
      ssh_keys: {
        keys: [
          {
            id: "k1",
            name: "Laptop",
            private: "-----BEGIN OPENSSH PRIVATE KEY----- nope",
            public: `  ${ed25519}  `,
            use_for_new_frames: true,
          },
          // The shared form's freshly added, not yet filled-in entry.
          { id: "k2", name: "Key 2", private: "", public: "", use_for_new_frames: false },
        ],
        // Legacy single-key fields are not a shape the cloud keeps.
        default: "x",
        default_public: "y",
      },
    });
    expect(error).toBeUndefined();
    expect(settings).toEqual({
      ssh_keys: {
        keys: [{ id: "k1", name: "Laptop", public: ed25519, use_for_new_frames: true }],
      },
    });
    expect(JSON.stringify(settings)).not.toContain("PRIVATE");
  });

  it("refuses SSH keys that are not OpenSSH public key lines", () => {
    for (const bad of [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "ssh-ed25519",
      'ssh-ed25519 AAAA"; rm -rf /',
      "ssh-ed25519 AAAA marius@laptop with spaces",
    ]) {
      expect(
        filterAccountSettings({ ssh_keys: { keys: [{ id: "k1", public: bad }] } }).error,
        bad,
      ).toBe("invalid_ssh_key");
    }
    expect(filterAccountSettings({ ssh_keys: { keys: "nope" } }).error).toBe("invalid_settings");
    expect(filterAccountSettings({ ssh_keys: { keys: [{ id: "bad id!", public: "ssh-ed25519 AAAA" }] } }).error).toBe(
      "invalid_settings",
    );
    expect(filterAccountSettings({ ssh_keys: [] }).error).toBe("invalid_settings");
  });

  it("never resolves groups or fields through Object.prototype", () => {
    for (const key of ["toString", "__proto__", "constructor", "valueOf"]) {
      expect(filterAccountSettings({ [key]: { x: "y" } }).settings).toEqual({});
      const inGroup = filterAccountSettings({ openAI: { [key]: "y" } });
      expect(inGroup.settings).toEqual({ openAI: {} });
    }
  });
});
