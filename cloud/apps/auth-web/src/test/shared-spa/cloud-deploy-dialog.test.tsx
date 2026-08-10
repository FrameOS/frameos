// @vitest-environment jsdom
//
// The deploy dialog, rendered as the cloud fleet UI renders it.
//
// FrameDeployPlanDrawer was written for the backend control plane: deploy
// plans fetched from POST /api/frames/{id}/deploy_plan, an SSH/agent
// transport toggle, SD-card and script install views, and the embedded
// firmware section that reads frame.embedded.firmware (which the BACKEND
// builds). A cloud frame has none of those fields — its summary carries
// `hardware`, not `mode` — so the drawer takes a cloud branch instead.
//
// What that branch is for: an enrolled esp32 board whose Wi-Fi credentials
// are wrong cannot be reached by the cloud at all. Its only repair channel is
// the USB serial console, and EmbeddedUsbSetup (pure WebSerial, no HTTP)
// already implements the repair — it was just mounted exclusively behind
// `frame.mode === 'embedded'`, a field cloud frames never have. These tests
// pin that it renders here, and that the backend-only build/flash controls
// next to it do not.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { FrameDeployPlanDrawer } from "../../../../../../frontend/src/scenes/workspace/FrameDeployPlanDrawer";
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
    scenes: [],
  } as unknown as FrameType;
}

type CloudTestWindow = Window & {
  FRAMEOS_APP_CONFIG?: { cloudMode: boolean };
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as CloudTestWindow;

beforeEach(() => {
  // Both USB surfaces render a "this browser can't do it" note without Web
  // Serial, so the controls under test only exist when it is present.
  Object.defineProperty(navigator, "serial", {
    configurable: true,
    value: { getPorts: () => Promise.resolve([]), requestPort: () => Promise.reject(new Error("no port")) },
  });
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
  delete (navigator as { serial?: unknown }).serial;
  vi.unstubAllGlobals();
  delete testWindow.FRAMEOS_APP_CONFIG;
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("the deploy dialog in cloud mode", () => {
  it("offers push-scenes and USB setup for an esp32 frame", () => {
    render(<FrameDeployPlanDrawer frame={cloudFrame("esp32")} />);

    // The cloud's deploy: settings push + one checksummed set_scenes.
    expect(screen.getByText("Push to frame")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Push scenes" })).toBeTruthy();
    // The firmware nudge, previously reachable only from the "…" menu.
    expect(screen.getByRole("button", { name: /Update firmware/ })).toBeTruthy();
    // ...and the USB route to the same released image, which is the only one
    // that works on a board that cannot reach the network — the state the USB
    // block below exists to repair.
    expect(screen.getByRole("button", { name: /Update over USB/ })).toBeTruthy();
    // The point of the whole exercise.
    expect(screen.getByText("USB setup")).toBeTruthy();
  });

  it("renders no backend deploy machinery", () => {
    render(<FrameDeployPlanDrawer frame={cloudFrame("esp32")} />);

    // Build host, SSH transport, SD cards, install scripts, fast-vs-full:
    // none of these exist on the cloud, and each one used to render because
    // the drawer read frame.mode (undefined -> treated as 'rpios').
    for (const backendOnly of [
      "Alternatives",
      "Download SD card",
      "Run a script",
      "Fast deploy",
      "Full deploy",
      "Build & download firmware",
      "Update over the air",
    ]) {
      expect(screen.queryByText(backendOnly)).toBeNull();
    }
  });

  it("leaves a cloud Pi frame the scene push without the esp32 USB block", () => {
    render(<FrameDeployPlanDrawer frame={cloudFrame("pi-zero2w")} />);

    expect(screen.getByRole("button", { name: "Push scenes" })).toBeTruthy();
    // USB provisioning and the firmware nudge are esp32-profile surfaces: a
    // cloud Pi is updated through the buildroot release flow, not a signed
    // firmware image, and it has no serial console to provision over.
    expect(screen.queryByText("USB setup")).toBeNull();
    expect(screen.queryByRole("button", { name: /Update firmware/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Update over USB/ })).toBeNull();
  });

  it("fetches no deploy plan (the cloud has no such endpoint)", () => {
    render(<FrameDeployPlanDrawer frame={cloudFrame("esp32")} />);

    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toContain("deploy_plan");
      expect(url).not.toContain("/sync");
    }
  });
});
