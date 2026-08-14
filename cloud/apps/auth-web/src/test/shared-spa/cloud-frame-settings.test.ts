import { describe, expect, it } from "vitest";
import {
  cloudFrameSettingKeys,
  cloudFrameSettingsPayload,
  esp32CloudFrameSettingKeys,
} from "../../../../../../frontend/src/utils/cloudFrameSettings";
import { allowedFrameCommandTypes, allowedFrameSettings } from "../../lib/frames";

// Save and Render in the shared SPA used to POST /api/frames/{id} and
// /api/frames/{id}/event/render — neither exists on the cloud, so both always
// errored. They now go through /settings and /command. The settings allowlist
// is triple-declared (SPA, this app's src/lib/frames.ts, and the device's
// CLOUD_SETTINGS_ALLOWLIST) and the device refuses the WHOLE push on an
// unknown key, so one extra key silently drops every setting. Pin the
// agreement between the two halves we can see from here.

describe("cloud settings push", () => {
  it("sends only keys the control plane accepts", () => {
    for (const key of esp32CloudFrameSettingKeys) {
      expect(
        allowedFrameSettings.has(key),
        `${key} is sent by the SPA but not on the control plane's allowlist`,
      ).toBe(true);
    }
  });

  it("covers every key the control plane accepts", () => {
    // The esp32 list is the superset: base keys for every frame plus the
    // power keys only the esp32 firmware consumes.
    for (const key of allowedFrameSettings.keys()) {
      expect(
        (esp32CloudFrameSettingKeys as readonly string[]).includes(key),
        `${key} is accepted by the control plane but never sent by the SPA`,
      ).toBe(true);
    }
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
