// @vitest-environment jsdom
//
// The per-frame Settings panel, rendered as the cloud fleet UI renders it.
//
// workspace-surfaces.test.ts pins which sections the NAV offers; this mounts
// the real panel, because the panel gates its own JSX and a nav that offers
// nothing is no help if the form underneath still draws twenty editable
// fields. That was the bug: a cloud-managed Linux frame rendered nearly the
// whole self-hosted form — display driver, network, mountpoints, palette,
// GPIO, log paths — none of which the cloud can save. `set_settings` refuses
// the WHOLE push on a key the device does not know, so those fields could
// never be made to work by typing harder; they silently dropped what you
// typed, or took the rest of the push down with them.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { BindLogic } from "../../../../../../frontend/node_modules/kea";
import { frameLogic } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { FrameSettings } from "../../../../../../frontend/src/scenes/frame/panels/FrameSettings/FrameSettings";
import {
  cloudFrameSettingKeys,
  extendedCloudFrameSettingKeys,
  extendedCloudFrameSettingsMinVersion,
  hardwareCloudFrameSettingsMinVersion,
} from "../../../../../../frontend/src/utils/cloudFrameSettings";
import type { FrameType } from "../../../../../../frontend/src/types";

const fetchMock = vi.fn<typeof fetch>();

function cloudFrame(
  platform: string,
  frameosVersion: string | null = extendedCloudFrameSettingsMinVersion,
  device?: string,
): FrameType {
  return {
    id: 1 as unknown as FrameType["id"],
    project_id: 1,
    name: `Frame on ${platform}`,
    managed_by: "cloud",
    frameos_version: frameosVersion,
    hardware: { platform, width: 800, height: 480, ...(device ? { device } : {}) },
    frame_host: "",
    frame_port: 8787,
    frame_access_key: "",
    frame_access: "private",
    ssh_port: 22,
    server_port: 8989,
    status: "active",
    interval: 300,
    metrics_interval: 60,
    rotate: 0,
    scaling_mode: "contain",
    background_color: "#000000",
    timezone: "Europe/Brussels",
    debug: false,
  } as unknown as FrameType;
}

type CloudTestWindow = Window & {
  FRAMEOS_APP_CONFIG?: { cloudMode: boolean };
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as CloudTestWindow;

beforeEach(() => {
  testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  document.body.innerHTML = '<div id="popper"></div><div id="root"></div>';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json({ frames: [] }));
  vi.stubGlobal("fetch", fetchMock);
  initKea();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete testWindow.FRAMEOS_APP_CONFIG;
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

function renderPanel(frame: FrameType) {
  // The panel reads frameLogic from context, exactly as FrameWorkspace binds
  // it — mounting it standalone would key on nothing.
  framesModel.mount();
  framesModel.actions.loadFramesSuccess({ [String(frame.id)]: frame });
  return render(
    <BindLogic logic={frameLogic} props={{ frameId: frame.id }}>
      <FrameSettings />
    </BindLogic>,
  );
}

/**
 * Every `name=` the panel put on a form control. Switches render as a
 * <button name=…> (components/Switch wraps headlessui), so buttons carrying a
 * name count too — `debug` is one, and a selector that missed it would let the
 * panel quietly stop offering a setting the device does accept.
 */
function renderedFieldNames(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      "input[name], select[name], textarea[name], button[name]",
    ),
  )
    .map((element) => element.getAttribute("name") ?? "")
    .filter((name) => name.length > 0 && name !== "_noop");
}

/**
 * The form-control names the extended batch's shared field blocks render.
 * Structured keys (control_code, error_behavior, timezone_updater) render
 * their sub-fields, so the name on the wire is not the name on the control —
 * this maps each rendered name back to the top-level setting it feeds.
 */
const extendedFieldNames: Record<string, (typeof extendedCloudFrameSettingKeys)[number]> = {
  flip: "flip",
  metrics_interval: "metrics_interval",
  max_http_response_bytes: "max_http_response_bytes",
  save_assets: "save_assets",
  "error_behavior.mode": "error_behavior",
  "error_behavior.retry_seconds": "error_behavior",
  "error_behavior.silent_retry_seconds": "error_behavior",
  "error_behavior.silent_retry_forever": "error_behavior",
  "error_behavior.silent_window_minutes": "error_behavior",
  "error_behavior.show_error_retry_seconds": "error_behavior",
  // <Group name="control_code">: enabled, position, size, padding, offsetX,
  // offsetY, qrCodeColor, backgroundColor — all but `enabled` render only
  // once the code is enabled.
  enabled: "control_code",
  position: "control_code",
  size: "control_code",
  padding: "control_code",
  offsetX: "control_code",
  offsetY: "control_code",
  qrCodeColor: "control_code",
  backgroundColor: "control_code",
};

/**
 * timezone_updater's controls carry no form name (a render-prop Switch and a
 * hand-wired hour input), so its presence is read off its label.
 */
function extendedSettingsCovered(): Set<string> {
  const covered = new Set<string>(
    renderedFieldNames().map((name) => extendedFieldNames[name]).filter(Boolean),
  );
  if (screen.queryByText("Update timezone data")) {
    covered.add("timezone_updater");
  }
  return covered;
}

describe("the Settings panel on a cloud-managed Linux frame", () => {
  it("renders an editable field only for settings the cloud can save", () => {
    renderPanel(cloudFrame("raspberry-pi-64"));

    const rendered = new Set(renderedFieldNames());
    const saveable = new Set<string>([
      ...cloudFrameSettingKeys,
      ...Object.keys(extendedFieldNames),
    ]);
    const unsaveable = [...rendered].filter((name) => !saveable.has(name));

    expect(
      unsaveable,
      "these fields are editable on a cloud frame but cannot be pushed to it",
    ).toEqual([]);
  });

  it("offers the hardware batch the reported panel can use, on firmware that knows it", () => {
    // A Spectra-6 Inky: a palette to edit and a fixed button map to show;
    // no partial refresh (that panel cannot do one).
    renderPanel(cloudFrame("raspberry-pi-64", "2026.8.31", "pimoroni.inky_impression_13"));
    const paletteSelect = document.querySelector<HTMLSelectElement>('select[name="palette"]');
    expect(paletteSelect, "the palette editor is missing").toBeTruthy();
    expect(paletteSelect?.matches(":disabled")).toBe(false);
    expect(screen.getByText("Configured")).toBeTruthy();
    expect(screen.queryByText("Partial refresh")).toBeNull();
    expect(screen.getByText(/restarts FrameOS on the frame/i)).toBeTruthy();
    cleanup();

    // A 7.5" V2: partial refresh, editable buttons, no palette.
    renderPanel(cloudFrame("raspberry-pi-64", "2026.8.31", "waveshare.EPD_7in5_V2"));
    expect(screen.getByText("Partial refresh")).toBeTruthy();
    expect(document.querySelector('select[name="palette"]')).toBeNull();
    expect(screen.getByText("Add button")).toBeTruthy();
  });

  it("disables (never hides) the hardware batch below its own floor", () => {
    renderPanel(cloudFrame("raspberry-pi-64", "2026.8.30", "pimoroni.inky_impression_13"));
    const paletteSelect = document.querySelector<HTMLSelectElement>('select[name="palette"]');
    expect(paletteSelect, "the field is hidden rather than disabled").toBeTruthy();
    expect(paletteSelect?.matches(":disabled")).toBe(true);
    expect(
      screen.getByText(new RegExp(`need FrameOS ${hardwareCloudFrameSettingsMinVersion.replaceAll(".", "\\.")} or newer`)),
    ).toBeTruthy();
    // The 2026.8.30 batch right next to it stays editable.
    const flip = document.querySelector<HTMLSelectElement>('select[name="flip"]');
    expect(flip?.matches(":disabled")).toBe(false);
  });

  it("still offers all six settings the device does accept", () => {
    renderPanel(cloudFrame("raspberry-pi-64"));

    const rendered = new Set(renderedFieldNames());
    for (const key of cloudFrameSettingKeys) {
      expect(rendered.has(key), `${key} is saveable but the panel omits it`).toBe(
        true,
      );
    }
  });

  it("offers every extended setting on firmware that knows the batch", () => {
    renderPanel(cloudFrame("raspberry-pi-64", "2026.9.1"));

    const covered = extendedSettingsCovered();
    for (const key of extendedCloudFrameSettingKeys) {
      expect(covered.has(key), `${key} is saveable but the panel omits it`).toBe(true);
    }
    // Enabled, not just present.
    const flip = document.querySelector<HTMLSelectElement>('select[name="flip"]');
    expect(flip?.matches(":disabled")).toBe(false);
  });

  it("disables (never hides) the extended settings on older firmware, and says why", () => {
    renderPanel(cloudFrame("raspberry-pi-64", "2026.8.21"));

    // Older firmware refuses the WHOLE push on the first key it does not
    // know, so the fields must not be editable — but they stay on the page
    // with the reason, the same disabled-with-explanation rule the esp32
    // profile follows for missing capabilities.
    const flip = document.querySelector<HTMLSelectElement>('select[name="flip"]');
    expect(flip, "the field is hidden rather than disabled").toBeTruthy();
    expect(flip?.matches(":disabled")).toBe(true);
    expect(
      screen.getByText(new RegExp(`need FrameOS ${extendedCloudFrameSettingsMinVersion.replaceAll(".", "\\.")} or newer`)),
    ).toBeTruthy();
    // The base six stay editable regardless.
    const name = document.querySelector<HTMLInputElement>('input[name="name"]');
    expect(name?.matches(":disabled")).toBe(false);
  });

  it("treats a frame that never reported a version as not yet supporting the batch", () => {
    renderPanel(cloudFrame("raspberry-pi-64", null));

    const flip = document.querySelector<HTMLSelectElement>('select[name="flip"]');
    expect(flip?.matches(":disabled")).toBe(true);
    // Both gated batches say so — the extended one and the hardware one.
    expect(screen.getAllByText(/once the frame connects and reports its version/i).length).toBe(2);
  });

  it("says who owns everything it is not showing", () => {
    renderPanel(cloudFrame("raspberry-pi-64"));

    // Hiding a section silently is its own kind of dishonest — "where did the
    // display driver go" needs an answer on the page.
    expect(
      screen.getByText(/owned by the device and configured on the frame itself/i),
    ).toBeTruthy();
  });

  it("draws none of the sections the device owns", () => {
    renderPanel(cloudFrame("raspberry-pi-64"));

    for (const heading of [
      "Device settings",
      "Network",
      "Mountpoints",
      "Palette",
      "Assets",
      "Logs",
      "Reboot",
      // Power belongs to the ESP32 profile alone: the Pi runtime's allowlist
      // has no power keys, so pushing them would refuse the whole save. Its
      // controls carry no form `name`, so only a heading check catches it —
      // which is how it slipped through the first version of this file.
      "Power",
    ]) {
      expect(
        screen.queryByText(heading),
        `${heading} is not something the cloud can change`,
      ).toBeNull();
    }
  });
});

describe("the Settings panel on a cloud-managed ESP32", () => {
  it("keeps Power, which only its firmware consumes", () => {
    renderPanel(cloudFrame("esp32-s3"));

    expect(screen.queryByText("Power")).toBeTruthy();
  });

  it("keeps its narrower set: no timezone the firmware ignores, no Pi-only batch", () => {
    renderPanel(cloudFrame("esp32-s3"));

    const rendered = new Set(renderedFieldNames());
    // What the firmware's ws_handle_set_settings actually applies.
    expect(rendered.has("name")).toBe(true);
    expect(rendered.has("interval")).toBe(true);
    expect(rendered.has("rotate")).toBe(true);
    expect(rendered.has("scaling_mode")).toBe(true);
    // Accepted by the control plane, unimplementable on the firmware — so
    // offering it here would be the same lie in a smaller font.
    expect(rendered.has("timezone")).toBe(false);
    // The Pi/Linux extended batch: the firmware has no consumer for any of
    // it except the HTTP ceiling it learned in 2026.8.31 (its own gated
    // section below), and the route refuses the rest for esp32 frames.
    for (const name of Object.keys(extendedFieldNames)) {
      if (name === "max_http_response_bytes") continue;
      expect(rendered.has(name), `${name} has no consumer in the esp32 firmware`).toBe(false);
    }
    expect(screen.queryByText("QR Control Code")).toBeNull();
    expect(screen.queryByText("Global errors")).toBeNull();
    expect(screen.queryByText("Panel")).toBeNull();
  });

  it("offers debug, the HTTP ceiling and GPIO buttons on firmware from 2026.8.31, disabled below it", () => {
    renderPanel(cloudFrame("esp32-s3", "2026.8.31"));
    const debug = document.querySelector<HTMLButtonElement>('button[name="debug"]');
    expect(debug, "the debug switch is missing").toBeTruthy();
    expect(debug?.matches(":disabled")).toBe(false);
    expect(document.querySelector('input[name="max_http_response_bytes"]')?.matches(":disabled")).toBe(false);
    expect(screen.getByText("Add button")).toBeTruthy();
    expect(screen.getByText(/reboots the frame/i)).toBeTruthy();
    cleanup();

    renderPanel(cloudFrame("esp32-s3", "2026.8.21"));
    const oldDebug = document.querySelector<HTMLButtonElement>('button[name="debug"]');
    expect(oldDebug, "the field is hidden rather than disabled").toBeTruthy();
    expect(oldDebug?.matches(":disabled")).toBe(true);
    expect(screen.getByText(/need FrameOS 2026\.8\.31 or newer/)).toBeTruthy();
    // The ungated set stays editable.
    expect(document.querySelector<HTMLInputElement>('input[name="interval"]')?.matches(":disabled")).toBe(false);
  });
});
