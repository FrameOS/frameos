// @vitest-environment jsdom
//
// The frame "…" actions menu, rendered as the cloud fleet UI renders it.
//
// A cloud-managed frame whose enrollment-reported hardware.platform is
// "esp32" implements only a subset of the management verbs — it answers
// `unsupported_verb` for set_schedule, set_settings, get_logs, get_metrics
// and notify_update_available (docs/cloud-frames.md "Device profiles";
// device-side allowlist in embedded/esp32/main/fos_cloud.c). Rename rides
// set_settings, so for an esp32 frame the menu shows it DISABLED with the
// reason as its tooltip — visible, never hidden — while render, reboot and
// restart (all in the esp32 profile) stay live.
//
// The component lives in frontend/src (the shared SPA), which has no test
// runner, so it is tested from auth-web's vitest across the package boundary
// like the other shared-spa suites. The pure allow-list logic is pinned in
// workspace-surfaces.test.ts; this renders the real menu to prove the wiring
// passes the frame through.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { FrameActionsMenu } from "../../../../../../frontend/src/scenes/workspace/FrameActionsMenu";
import type { FrameType } from "../../../../../../frontend/src/types";

const fetchMock = vi.fn<typeof fetch>();

function cloudFrame(platform: string): FrameType {
  return {
    id: `frame-${platform}` as unknown as FrameType["id"],
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
    scaling_mode: "contain",
    background_color: "#000000",
  };
}

function renderMenu(frame: FrameType) {
  const view = render(<FrameActionsMenu frame={frame} />);
  // DropdownMenu items render behind the (closed) Menu.Button, portaled to
  // #popper — open it so the item list exists in the DOM.
  fireEvent.click(screen.getByRole("button"));
  return view;
}

function menuItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".frameos-dropdown-item"));
}

function menuLabels(): string[] {
  return menuItems().map((item) => item.textContent?.trim() ?? "");
}

function menuItem(label: string): HTMLElement | undefined {
  return menuItems().find((item) => item.textContent?.trim() === label);
}

// The cloud fleet UI's runtime globals (cloud-frontend/src/main.tsx).
type CloudTestWindow = Window & {
  FRAMEOS_APP_CONFIG?: { cloudMode: boolean };
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as CloudTestWindow;

beforeEach(() => {
  // The cloud fleet UI's runtime config (cloud-frontend/src/main.tsx), which
  // is what makes workspaceMode() say "cloud". FRAMEOS_EMBEDDED_NO_BACKEND
  // keeps socketLogic from dialing a WebSocket jsdom does not have.
  testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  document.body.innerHTML = '<div id="popper"></div><div id="root"></div>';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json({ frames: [] }));
  vi.stubGlobal("fetch", fetchMock);
  // Fresh kea context per test: mounting FrameActionsMenu mounts framesModel
  // and workspaceLogic, whose state must not leak across tests.
  initKea();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete testWindow.FRAMEOS_APP_CONFIG;
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("FrameActionsMenu in cloud mode", () => {
  it("disables Rename with an explanation for an esp32 frame and keeps render, restart and reboot live", () => {
    renderMenu(cloudFrame("esp32"));

    const labels = menuLabels();
    expect(labels).toContain("Rename");
    expect(labels).toContain("Re-render");
    expect(labels).toContain("Restart FrameOS");
    expect(labels).toContain("Reboot device");

    const rename = menuItem("Rename");
    expect(rename?.className).toContain("cursor-not-allowed");
    expect(rename?.getAttribute("title")).toContain("ESP32");

    // The live entries carry no disabling and their normal tooltips.
    const rerender = menuItem("Re-render");
    expect(rerender?.className).not.toContain("cursor-not-allowed");
    expect(rerender?.getAttribute("title")).toBe("Render frame now");
  });

  it("still offers nothing the cloud protocol itself lacks on esp32", () => {
    renderMenu(cloudFrame("esp32"));

    const labels = menuLabels();
    for (const backendOnly of ["Deploy", "Build SD card", "Stop FrameOS", "Delete", "Archive"]) {
      expect(labels).not.toContain(backendOnly);
    }
  });

  it("keeps Rename enabled for a Pi frame", () => {
    renderMenu(cloudFrame("pi-zero2w"));

    const labels = menuLabels();
    expect(labels).toContain("Rename");
    expect(labels).toContain("Re-render");
    expect(labels).toContain("Restart FrameOS");
    expect(labels).toContain("Reboot device");

    const rename = menuItem("Rename");
    expect(rename?.className).not.toContain("cursor-not-allowed");
    expect(rename?.getAttribute("title")).toBe("Rename frame");
  });
});
