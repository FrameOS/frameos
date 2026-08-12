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
// The cloud branch is a two-path chooser: a frame has exactly two transports
// (its own outbound cloud connection, or a USB cable to this computer), so
// the drawer opens on that choice and puts every action behind the path it
// belongs to. These tests pin the chooser, both views, the USB-only landing
// for a frame no board has enrolled as, and that the backend-only build/flash
// controls never render here.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { FrameDeployPlanDrawer } from "../../../../../../frontend/src/scenes/workspace/FrameDeployPlanDrawer";
import type { FrameType } from "../../../../../../frontend/src/types";

const fetchMock = vi.fn<typeof fetch>();

function cloudFrame(platform: string, overrides: Partial<FrameType> = {}): FrameType {
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
    ...overrides,
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
  // Choosing a deploy path pushes ?deployView=… into the (jsdom-global) URL;
  // without this reset one test's choice leaks into the next test's render.
  window.history.replaceState({}, "", "/");
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
  it("opens an esp32 frame on the status summary and the OTA-vs-USB choice", () => {
    render(<FrameDeployPlanDrawer frame={cloudFrame("esp32")} />);

    // The "what is there to update" summary every view opens with.
    expect(screen.getByText("What's on the frame")).toBeTruthy();
    // The two transports a cloud frame has, and nothing else: the actions
    // live behind the choice, so the chooser itself carries none of them.
    expect(screen.getByRole("button", { name: /Over the air/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Over USB/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Push scenes/ })).toBeNull();
    expect(screen.queryByText("Wi-Fi & device status")).toBeNull();
    // The hardware panel renders even before the device reports the full
    // detail — with a note saying when it fills in.
    expect(screen.getByText("Hardware")).toBeTruthy();
  });

  it("puts the push and the firmware nudge behind the over-the-air path", () => {
    render(<FrameDeployPlanDrawer frame={cloudFrame("esp32")} />);
    fireEvent.click(screen.getByRole("button", { name: /Over the air/ }));

    // The cloud's deploy: settings push + one checksummed set_scenes.
    expect(screen.getByRole("button", { name: /Push scenes & settings/ })).toBeTruthy();
    // The firmware nudge (notify_update_available; the device downloads and
    // signature-verifies the image itself).
    expect(screen.getByRole("button", { name: /Update firmware/ })).toBeTruthy();
    // OTA progress is only visible as ota:cloud log lines, so the view links
    // straight to them.
    expect(screen.getByRole("button", { name: /Follow along in Logs/ })).toBeTruthy();
    // The USB surfaces stay behind the other path.
    expect(screen.queryByText("Wi-Fi & device status")).toBeNull();
    expect(screen.queryByRole("button", { name: /Update over USB/ })).toBeNull();
  });

  it("orders the USB path firmware, scene push, then Wi-Fi repair", () => {
    render(<FrameDeployPlanDrawer frame={cloudFrame("esp32")} />);
    fireEvent.click(screen.getByRole("button", { name: /Over USB/ }));

    // 1. The NVS-sparing firmware update…
    expect(screen.getByRole("button", { name: /Update over USB/ })).toBeTruthy();
    // 2. …the same scene bodies the OTA push sends, over the cable (behind a
    // connect button until a board is attached)…
    expect(screen.getByText("Push scenes & settings")).toBeTruthy();
    expect(screen.getByText(/Connect the board over USB to push scenes/)).toBeTruthy();
    // 3. …and WebSerial provisioning, the only repair channel for a board
    // whose Wi-Fi credentials are wrong.
    expect(screen.getByText("Wi-Fi & device status")).toBeTruthy();
    // Re-enrolling a WIPED board is enrollment, not deployment: it moved to
    // the "Add frame" panel and only a pointer remains.
    expect(screen.queryByText(/Connect & re-enroll/)).toBeNull();
    expect(screen.getByText(/re-connect it from the "Add\s?frame" panel/i)).toBeTruthy();
  });

  it("lands a frame no board has enrolled as straight on the USB view", () => {
    render(<FrameDeployPlanDrawer frame={cloudFrame("esp32", { status: "pending" })} />);

    // Over the air cannot reach a frame with no device behind it (the command
    // queue 409s), so the choice would be a trick question.
    expect(screen.getByText("Wi-Fi & device status")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Over the air/ })).toBeNull();
    // No way back to a chooser that is not offered.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
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

  it("leaves a cloud Pi frame the scene push without the esp32 surfaces", () => {
    render(<FrameDeployPlanDrawer frame={cloudFrame("pi-zero2w")} />);

    expect(screen.getByRole("button", { name: /Push scenes & settings/ })).toBeTruthy();
    // USB provisioning, the firmware nudge and the hardware panel are
    // esp32-profile surfaces: a cloud Pi is updated through the buildroot
    // release flow, not a signed firmware image, and it has no serial console
    // to provision over.
    expect(screen.queryByRole("button", { name: /Over the air/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Over USB/ })).toBeNull();
    expect(screen.queryByText("Wi-Fi & device status")).toBeNull();
    expect(screen.queryByRole("button", { name: /Update firmware/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Update over USB/ })).toBeNull();
    expect(screen.queryByText("Hardware")).toBeNull();
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
