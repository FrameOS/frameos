import { describe, expect, it } from "vitest";
import {
  allCloudFrameSettingKeys,
  cloudFrameSettingKeys,
  cloudFrameSettingKeysForVersion,
  cloudFrameSettingsPayload,
  cloudFrameSupportsExtendedSettings,
  esp32CloudFrameSettingKeys,
  extendedCloudFrameSettingKeys,
  extendedCloudFrameSettingsMinVersion,
} from "../../../../../../frontend/src/utils/cloudFrameSettings";
import {
  allowedFrameCommandTypes,
  allowedFrameSettings,
  esp32OnlySettableKeys,
  esp32SettableKeys,
  extendedFrameSettingKeys,
  extendedFrameSettingsMinVersion,
  frameSupportsExtendedSettings,
} from "../../lib/frames";

// Save and Render in the shared SPA used to POST /api/frames/{id} and
// /api/frames/{id}/event/render — neither exists on the cloud, so both always
// errored. They now go through /settings and /command. The settings allowlist
// is triple-declared (SPA, this app's src/lib/frames.ts, and the device's
// CLOUD_SETTINGS_ALLOWLIST) and the device refuses the WHOLE push on an
// unknown key, so one extra key silently drops every setting. Pin the
// agreement between the two halves we can see from here.

describe("cloud settings push", () => {
  it("sends only keys the control plane accepts", () => {
    for (const key of allCloudFrameSettingKeys) {
      expect(
        allowedFrameSettings.has(key),
        `${key} is sent by the SPA but not on the control plane's allowlist`,
      ).toBe(true);
    }
  });

  it("covers every key the control plane accepts", () => {
    // allCloudFrameSettingKeys is the superset: base keys for every frame,
    // the extended Pi/Linux batch, and the power keys only the esp32
    // firmware consumes.
    for (const key of allowedFrameSettings.keys()) {
      expect(
        (allCloudFrameSettingKeys as readonly string[]).includes(key),
        `${key} is accepted by the control plane but never sent by the SPA`,
      ).toBe(true);
    }
  });

  it("agrees with the control plane on which keys are the extended batch, and its floor", () => {
    expect(new Set(extendedCloudFrameSettingKeys)).toEqual(extendedFrameSettingKeys);
    expect(extendedCloudFrameSettingsMinVersion).toBe(extendedFrameSettingsMinVersion);
    // Extended keys are Pi/Linux only: the route refuses them for esp32
    // frames, so the SPA's esp32 list must not carry them.
    for (const key of extendedCloudFrameSettingKeys) {
      expect(esp32SettableKeys.has(key)).toBe(false);
      expect(esp32OnlySettableKeys.has(key)).toBe(false);
      expect((esp32CloudFrameSettingKeys as readonly string[]).includes(key)).toBe(false);
    }
  });

  it("decides firmware support the same way the control plane does", () => {
    // Both halves see the same reported version; if they disagree the SPA
    // offers fields the route then refuses (or hides ones it would accept).
    for (const version of [
      null,
      undefined,
      "",
      "   ",
      "unknown",
      "nightly",
      "2026.8.21",
      "2026.8.29",
      "2026.8.30",
      "v2026.8.30",
      "2026.8.30+abc123",
      "2026.8.31",
      "2026.9.0",
      "2026.10.0",
      "2027.1.0",
    ]) {
      expect(
        cloudFrameSupportsExtendedSettings(version),
        `SPA vs control plane disagree on ${JSON.stringify(version)}`,
      ).toBe(frameSupportsExtendedSettings(version));
    }
    expect(cloudFrameSupportsExtendedSettings("2026.8.29")).toBe(false);
    expect(cloudFrameSupportsExtendedSettings("2026.8.30")).toBe(true);
    expect(cloudFrameSupportsExtendedSettings("2026.10.0")).toBe(true);
    // A dev build is trusted; a frame that never reported is not.
    expect(cloudFrameSupportsExtendedSettings("unknown")).toBe(true);
    expect(cloudFrameSupportsExtendedSettings(null)).toBe(false);
  });

  it("only includes the extended batch for firmware that knows it", () => {
    expect(cloudFrameSettingKeysForVersion("2026.8.21")).toEqual([...cloudFrameSettingKeys]);
    expect(cloudFrameSettingKeysForVersion("2026.8.30")).toEqual([
      ...cloudFrameSettingKeys,
      ...extendedCloudFrameSettingKeys,
    ]);
  });

  it("converts the extended batch into the wire shapes the validators want", () => {
    const payload = cloudFrameSettingsPayload(
      {
        flip: "",
        metrics_interval: "0",
        max_http_response_bytes: "4194304",
        save_assets: { unsplash: true, openai: false, junk: "yes" },
        timezone_updater: { enabled: true, hour: "5", url: "https://evil.example/tz.json.gz" },
        control_code: {
          enabled: "true",
          position: "bottom-left",
          size: "3",
          padding: "2",
          offsetX: "-4",
          offsetY: "10",
          qrCodeColor: "#112233",
          backgroundColor: "#ffffff",
        },
        error_behavior: {
          mode: "silent_retry",
          retry_seconds: "30",
          silent_retry_forever: true,
          silent_window_minutes: 15,
          shell: "rm -rf /",
        },
      } as never,
      [...cloudFrameSettingKeys, ...extendedCloudFrameSettingKeys],
    );
    expect(payload).toEqual({
      flip: "",
      metrics_interval: 0,
      max_http_response_bytes: 4194304,
      save_assets: { unsplash: true, openai: false },
      // The URL is never the provider's to send.
      timezone_updater: { enabled: true, hour: 5 },
      control_code: {
        enabled: true,
        position: "bottom-left",
        size: 3,
        padding: 2,
        offsetX: -4,
        offsetY: 10,
        qrCodeColor: "#112233",
        backgroundColor: "#ffffff",
      },
      error_behavior: {
        mode: "silent_retry",
        retry_seconds: 30,
        silent_retry_forever: true,
        silent_window_minutes: 15,
      },
    });
    // Every value must pass the control plane's own validator, or the push
    // comes back 400 setting_not_allowed.
    for (const [key, value] of Object.entries(payload)) {
      expect(allowedFrameSettings.get(key)?.(value), `${key}`).toBe(true);
    }
  });

  it("keeps the extended keys out of the base payload", () => {
    const payload = cloudFrameSettingsPayload({ flip: "horizontal", interval: 300 } as never);
    expect(Object.keys(payload)).toEqual(["interval"]);
  });

  it("keeps the power keys out of the base (Pi) payload", () => {
    // The Pi runtime's CLOUD_SETTINGS_ALLOWLIST does not know the power keys
    // and refuses the WHOLE push on an unknown key.
    for (const key of cloudFrameSettingKeys) {
      expect(key.startsWith("battery_") || key.includes("sleep") || key.includes("wake")).toBe(false);
    }
    const payload = cloudFrameSettingsPayload({
      deep_sleep: true,
      interval: 300,
    } as never);
    expect(Object.keys(payload)).toEqual(["interval"]);
  });

  it("drops everything else from a full frame form", () => {
    const payload = cloudFrameSettingsPayload({
      debug: true,
      frame_host: "192.168.1.10",
      interval: 300,
      name: "Kitchen",
      rotate: 90,
      scaling_mode: "cover",
      ssh_pass: "hunter2",
      timezone: "Europe/Tallinn",
    } as never);
    expect(Object.keys(payload).sort()).toEqual([
      "debug",
      "interval",
      "name",
      "rotate",
      "scaling_mode",
      "timezone",
    ]);
    // Every value must pass the control plane's own validator, or the push
    // comes back 400 setting_not_allowed.
    for (const [key, value] of Object.entries(payload)) {
      expect(allowedFrameSettings.get(key)?.(value), `${key}`).toBe(true);
    }
  });

  it("skips unset values rather than sending nulls the validator rejects", () => {
    expect(cloudFrameSettingsPayload({ name: "Kitchen" })).toEqual({
      name: "Kitchen",
    });
    expect(cloudFrameSettingsPayload({})).toEqual({});
  });

  it("coerces the numeric fields the form keeps as strings", () => {
    const payload = cloudFrameSettingsPayload({
      interval: "300",
      rotate: "90",
    } as never);
    expect(payload).toEqual({ interval: 300, rotate: 90 });
    expect(allowedFrameSettings.get("interval")?.(payload.interval)).toBe(true);
    expect(allowedFrameSettings.get("rotate")?.(payload.rotate)).toBe(true);
  });
});

describe("cloud command verbs", () => {
  it("still accepts the verbs the SPA now routes Render/Reboot/Restart to", () => {
    expect(allowedFrameCommandTypes.has("render")).toBe(true);
    expect(allowedFrameCommandTypes.has("reboot")).toBe(true);
    expect(allowedFrameCommandTypes.has("restart_runtime")).toBe(true);
  });

  it("accepts notify_update_available (the Update-firmware menu entry)", () => {
    // Advisory only: the device fetches the signed OTA manifest and verifies
    // the image itself (docs/cloud-frames.md "Signed OTA"); the queue can
    // only suggest. The hub delivers whatever the durable queue holds, so
    // this allow-list IS the gate.
    expect(allowedFrameCommandTypes.has("notify_update_available")).toBe(true);
  });
});
