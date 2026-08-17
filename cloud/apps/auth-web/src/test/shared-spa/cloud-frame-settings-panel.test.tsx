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
import { cloudFrameSettingKeys } from "../../../../../../frontend/src/utils/cloudFrameSettings";
import type { FrameType } from "../../../../../../frontend/src/types";

const fetchMock = vi.fn<typeof fetch>();

function cloudFrame(platform: string): FrameType {
  return {
    id: 1 as unknown as FrameType["id"],
    project_id: 1,
    name: `Frame on ${platform}`,
    managed_by: "cloud",
    hardware: { platform, width: 800, height: 480 },
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

describe("the Settings panel on a cloud-managed Linux frame", () => {
  it("renders an editable field only for settings the cloud can save", () => {
    renderPanel(cloudFrame("raspberry-pi-64"));

    const rendered = new Set(renderedFieldNames());
    const saveable = new Set<string>(cloudFrameSettingKeys);
    const unsaveable = [...rendered].filter((name) => !saveable.has(name));

    expect(
      unsaveable,
      "these fields are editable on a cloud frame but cannot be pushed to it",
    ).toEqual([]);
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
      "QR Control Code",
      "Assets",
      "Logs",
      "Reboot",
    ]) {
      expect(
        screen.queryByText(heading),
        `${heading} is not something the cloud can change`,
      ).toBeNull();
    }
  });
});

describe("the Settings panel on a cloud-managed ESP32", () => {
  it("keeps its narrower set: no timezone or debug the firmware ignores", () => {
    renderPanel(cloudFrame("esp32-s3"));

    const rendered = new Set(renderedFieldNames());
    // What the firmware's ws_handle_set_settings actually applies.
    expect(rendered.has("name")).toBe(true);
    expect(rendered.has("interval")).toBe(true);
    expect(rendered.has("rotate")).toBe(true);
    expect(rendered.has("scaling_mode")).toBe(true);
    // Accepted by the control plane, ignored by the firmware — so offering
    // them here would be the same lie in a smaller font.
    expect(rendered.has("timezone")).toBe(false);
    expect(rendered.has("debug")).toBe(false);
  });
});
