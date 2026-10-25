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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { BindLogic } from "../../../../../../frontend/node_modules/kea";
import { frameLogic } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { FrameSettings } from "../../../../../../frontend/src/scenes/frame/panels/FrameSettings/FrameSettings";
import {
  cloudFrameSettingKeys,
  displayDriverCloudFrameSettingKeys,
  displayDriverCloudFrameSettingsMinVersion,
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
  hardware: Partial<NonNullable<FrameType["hardware"]>> = {},
): FrameType {
  return {
    id: 1 as unknown as FrameType["id"],
    project_id: 1,
    name: `Frame on ${platform}`,
    managed_by: "cloud",
    frameos_version: frameosVersion,
    hardware: { platform, width: 800, height: 480, ...(device ? { device } : {}), ...hardware },
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
  // <Group name="input_settings"> (the input batch, 2026.9.23).
  keyboardLayout: "input_settings",
  grabKeyboard: "input_settings",
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
      ...displayDriverCloudFrameSettingKeys,
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
    // Every gated batch says so — the extended one, the hardware one, the
    // display driver, the input batch, the colours batch and the button
    // actions (the frame's event map).
    expect(screen.getAllByText(/once the frame connects and reports its version/i).length).toBe(6);
  });

  it("offers the display driver on firmware that takes it, showing the one the frame reports", () => {
    renderPanel(cloudFrame("raspberry-pi-32", displayDriverCloudFrameSettingsMinVersion, "framebuffer"));
    const driver = document.querySelector<HTMLSelectElement>('select[name="device"]');
    expect(driver, "the display driver field is missing").toBeTruthy();
    expect(driver?.matches(":disabled")).toBe(false);
    expect(driver?.value).toBe("framebuffer");
    const options = Array.from(driver?.querySelectorAll("option") ?? []).map((option) => option.value);
    expect(options).toContain("pimoroni.hyperpixel4sq_touch");
    // Its upload URL is not a setting the cloud can push.
    expect(options).not.toContain("http.upload");
  });

  it("disables (never hides) the display driver below its floor, and says why", () => {
    renderPanel(cloudFrame("raspberry-pi-32", "2026.9.21", "framebuffer"));
    const driver = document.querySelector<HTMLSelectElement>('select[name="device"]');
    expect(driver, "the field is hidden rather than disabled").toBeTruthy();
    expect(driver?.matches(":disabled")).toBe(true);
    expect(screen.getByText(/Changing the display driver needs FrameOS 2026\.9\.22 or newer/)).toBeTruthy();
  });

  it("offers the account's SSH keys, which go on the SD cards it builds", () => {
    // Regression: commit 97c8c750 swept this section into the panel's
    // `!cloudProfile` branch, so it stopped rendering for every cloud frame
    // while the settings nav kept offering a link to its anchor. Nothing
    // caught it — the gating was forty nested ternaries deep. The panel's
    // surfaces are now a table (frameSettingsSurface.ts) checked against that
    // nav list by frame-settings-surface.test.ts.
    renderPanel(cloudFrame("raspberry-pi-64"));

    expect(screen.getByText("SSH keys")).toBeTruthy();
    expect(document.getElementById("frame-settings-ssh")).toBeTruthy();
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

  it("offers no SSH keys: an ESP32 is flashed, not imaged", () => {
    renderPanel(cloudFrame("esp32-s3"));

    expect(screen.queryByText("SSH keys")).toBeNull();
  });

  it("keeps its narrower set: no Pi-only batch", () => {
    renderPanel(cloudFrame("esp32-s3"));

    const rendered = new Set(renderedFieldNames());
    // What the firmware's ws_handle_set_settings actually applies.
    expect(rendered.has("name")).toBe(true);
    expect(rendered.has("interval")).toBe(true);
    expect(rendered.has("rotate")).toBe(true);
    expect(rendered.has("scaling_mode")).toBe(true);
    // Time zone arrived in firmware 2026.8.34 (IANA name -> POSIX TZ rule):
    // offered, but disabled with the floor spelled out on older firmware.
    expect(rendered.has("timezone")).toBe(true);
    expect(document.querySelector('[name="timezone"]')?.matches(":disabled")).toBe(true);
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

  it("knows a Spectra PhotoPainter fits by default, from the panel in its hardware report", () => {
    // The cloud fills no `device` for an ESP32: the panel name lives in the
    // enrollment report alone, as the bare waveshare key. Read from
    // `frame.device` the section found no palette and told the owner of a
    // six-ink panel that "this display shows full color".
    renderPanel(cloudFrame("esp32-s3", "2026.10.2", "EPD_7in3e"));
    expect(screen.getAllByText("Default (on for this panel)").length).toBeGreaterThan(0);
    expect(screen.queryByText("Default (off for this display)")).toBeNull();
    cleanup();

    // A grayscale panel dithers too, but the device leaves the fit off there.
    renderPanel(cloudFrame("esp32-s3", "2026.10.2", "EPD_4in26"));
    expect(screen.getAllByText("Default (off for this display)").length).toBeGreaterThan(0);
    expect(screen.queryByText("Default (on for this panel)")).toBeNull();
  });

  it("draws the voice chat switch and what it may do only on a frame with a microphone", () => {
    // docs/voice-chat.md "What the voice chat may do". An E1004 has no
    // microphone and reports -1 for every pin: the pins field stays (a PDM
    // microphone on its J2 header is declared there) and says plainly what
    // empty means, "-1"; the switch and the permission switches are not
    // drawn, and Button actions does not offer Voice chat.
    const pinPlaceholders = () =>
      [...document.querySelectorAll<HTMLInputElement>("input[placeholder]")]
        .map((input) => input.placeholder)
        .filter((placeholder) => placeholder === "-1" || placeholder.endsWith("(board default)"));
    renderPanel(
      cloudFrame("esp32-s3", "2026.10.20", "EPD_13in3e", {
        hardwarePreset: "seeed_reterminal_e1004",
        micClkPin: -1,
        micDataPin: -1,
        micPwrPin: -1,
        microphone: false,
        voiceChat: true,
      }),
    );
    expect(screen.queryByText("Microphone GPIO")).toBeTruthy();
    expect(pinPlaceholders()).toEqual(["-1", "-1", "-1"]);
    expect(screen.queryByText("Voice chat")).toBeNull();
    expect(screen.queryByText("Voice chat may")).toBeNull();
    expect(renderedFieldNames()).not.toContain("voice_create_scenes");
    cleanup();

    // Older firmware reports no pins at all: an E1004's preset has none, so
    // the same; an E1002's preset has them, so the controls are drawn (and
    // disabled below the firmware floor) with the preset's pins spelled out.
    renderPanel(cloudFrame("esp32-s3", "2026.10.19", "EPD_13in3e", { hardwarePreset: "seeed_reterminal_e1004" }));
    expect(pinPlaceholders()).toEqual(["-1", "-1", "-1"]);
    expect(screen.queryByText("Voice chat may")).toBeNull();
    cleanup();
    renderPanel(cloudFrame("esp32-s3", "2026.10.19", "EPD_7in3e", { hardwarePreset: "seeed_reterminal_e1002" }));
    expect(pinPlaceholders()).toEqual(["42 (board default)", "41 (board default)", "38 (board default)"]);
    expect(screen.queryByText("Voice chat may")).toBeTruthy();
    expect(document.querySelector('button[name="voice_use_scenes"]')?.matches(":disabled")).toBe(true);
    cleanup();

    // An E1002 whose clock was set to -1 on its console has no microphone any more.
    renderPanel(
      cloudFrame("esp32-s3", "2026.10.20", "EPD_7in3e", {
        hardwarePreset: "seeed_reterminal_e1002",
        micClkPin: -1,
        micDataPin: 41,
        micPwrPin: 38,
        microphone: false,
      }),
    );
    expect(pinPlaceholders()).toEqual(["-1", "41 (board default)", "38 (board default)"]);
    expect(screen.queryByText("Voice chat may")).toBeNull();
    cleanup();

    // An E1002 reports its pins: the switch, and the switches as the frame
    // row has them (the defaults filled in by the cloud).
    const frame = cloudFrame("esp32-s3", "2026.10.20", "EPD_7in3e", {
      hardwarePreset: "seeed_reterminal_e1002",
      micClkPin: 42,
      micDataPin: 41,
      micPwrPin: 38,
      microphone: true,
      voiceChat: true,
    });
    renderPanel({
      ...frame,
      voice_permissions: { change_settings: true, create_scenes: false, use_albums: true, use_scenes: false },
    });
    expect(pinPlaceholders()).toEqual(["42 (board default)", "41 (board default)", "38 (board default)"]);
    expect(screen.getAllByText("Voice chat").length).toBeGreaterThan(0);
    expect(screen.getByText("Voice chat may")).toBeTruthy();
    expect(renderedFieldNames()).toEqual(
      expect.arrayContaining(["voice_change_settings", "voice_use_scenes", "voice_create_scenes", "voice_use_albums"]),
    );
    expect(
      screen.getAllByText("On: a spoken request can list your photo albums and play one on the frame").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("On: a spoken request can rotate the frame").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Off: the installed scenes are left alone").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Off: only the scenes already on the frame").length).toBeGreaterThan(0);
    // A flip edits the form's `voice_permissions` (its own route on save), not a device key.
    fireEvent.click(document.querySelector('button[name="voice_create_scenes"]')!);
    expect(screen.getAllByText("On: a spoken request can put a new scene on the frame, such as a picture").length).toBeGreaterThan(0);
    expect(frameLogic({ frameId: frame.id }).values.frameForm.voice_permissions).toEqual({
      change_settings: true,
      create_scenes: true,
      use_albums: true,
      use_scenes: false,
    });
  });

  it("shows the button map the frame reported, and edits start from it", () => {
    // A reTerminal E1004 provisioned over USB runs the three keys its
    // `set hardware` bundle gave it; the cloud never pushed a list, so the
    // form has none. The section used to show nothing but "Add button".
    const reported = [
      { pin: 3, label: "REFRESH" },
      { pin: 4, label: "LEFT" },
      { pin: 5, label: "RIGHT" },
    ];
    renderPanel(cloudFrame("esp32-s3", "2026.10.7", "EPD_13in3e", { hardwarePreset: "seeed_reterminal_e1004", gpioButtons: reported }));
    expect(screen.getByText("On the frame")).toBeTruthy();
    expect(screen.queryByText("Add button")).toBeNull();
    const pins = [...document.querySelectorAll<HTMLInputElement>("input[readonly]")]
      .map((input) => input.value)
      .filter((value) => /^\d+$/.test(value));
    expect(pins).toEqual(["3", "4", "5"]);
    // Read-only: no editable per-button fields yet.
    expect(document.querySelector('input[name="pin"]')).toBeNull();

    // Edit seeds the editable list with the reported map, so a save pushes
    // a change to it rather than an unrelated list.
    fireEvent.click(screen.getByText("Edit buttons"));
    const editable = [...document.querySelectorAll<HTMLInputElement>('input[name="pin"]')].map((input) => input.value);
    expect(editable).toEqual(["3", "4", "5"]);
    const labels = [...document.querySelectorAll<HTMLInputElement>('input[name="label"]')].map((input) => input.value);
    expect(labels).toEqual(["REFRESH", "LEFT", "RIGHT"]);
    expect(screen.queryByText("On the frame")).toBeNull();
    expect(screen.getByText("Add button")).toBeTruthy();
    cleanup();

    // A frame that reports no buttons says so and offers the list.
    renderPanel(cloudFrame("esp32-s3", "2026.10.7", "EPD_7in5_V2", { gpioButtons: [] }));
    expect(screen.getByText("No buttons set on the frame.")).toBeTruthy();
    expect(screen.getByText("Add button")).toBeTruthy();
    cleanup();

    // Firmware without the report (no `gpioButtons` key) keeps the plain list.
    renderPanel(cloudFrame("esp32-s3", "2026.8.31", "EPD_7in5_V2"));
    expect(screen.queryByText("On the frame")).toBeNull();
    expect(screen.getByText("Add button")).toBeTruthy();
  });

  it("enables the time zone field from firmware 2026.8.34", () => {
    renderPanel(cloudFrame("esp32-s3", "2026.8.34"));
    expect(document.querySelector('[name="timezone"]')?.matches(":disabled")).toBe(false);
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
