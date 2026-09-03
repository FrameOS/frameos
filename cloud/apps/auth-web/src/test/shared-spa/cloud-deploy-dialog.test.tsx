// @vitest-environment jsdom
//
// The deploy dialog, rendered as the cloud fleet UI renders it.
//
// FrameDeployPlanDrawer was written for the backend control plane: deploy
// plans fetched from POST /api/frames/{id}/deploy_plan, an SSH/agent
// transport toggle, SD-card and script install views, and the embedded
// firmware section (the backend's release flasher, its OTA button and the
// flash layout it derives). A cloud frame has none of those fields — its
// summary carries `hardware`, not `mode` — so the drawer takes a cloud branch
// instead.
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

function cloudFrame(
  platform: string,
  overrides: Partial<FrameType> = {},
): FrameType {
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
    value: {
      getPorts: () => Promise.resolve([]),
      requestPort: () => Promise.reject(new Error("no port")),
    },
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
    expect(
      screen.getByRole("button", { name: /Push scenes & settings/ }),
    ).toBeTruthy();
    // The firmware nudge (notify_update_available; the device downloads and
    // signature-verifies the image itself). The label is constant — the
    // checkbox next to it is what says whether scenes ride along, and a
    // button that renamed itself made the two disagree.
    expect(
      screen.getByRole("button", { name: /Upgrade firmware/ }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Resend scenes & settings/ }),
    );
    expect(
      screen.getByRole("button", { name: /Upgrade firmware/ }),
    ).toBeTruthy();
    // OTA progress is only visible as ota:cloud log lines, so the view links
    // straight to them.
    expect(
      screen.getByRole("button", { name: /Follow along in Logs/ }),
    ).toBeTruthy();
    // Order: firmware (where the "Over the air" button was), then scenes &
    // settings, then logs — the action the user came for is under the mouse.
    const firmware = screen.getByRole("button", { name: /Upgrade firmware/ });
    const scenes = screen.getByRole("button", {
      name: /Push scenes & settings/,
    });
    const logs = screen.getByRole("button", { name: /Follow along in Logs/ });
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(firmware.compareDocumentPosition(scenes) & FOLLOWING).toBeTruthy();
    expect(scenes.compareDocumentPosition(logs) & FOLLOWING).toBeTruthy();
    // The resend tick sits under the upgrade button, not above it.
    const resend = screen.getByRole("checkbox", {
      name: /Resend scenes & settings/,
    });
    expect(firmware.compareDocumentPosition(resend) & FOLLOWING).toBeTruthy();
    // The USB surfaces stay behind the other path.
    expect(screen.queryByText("Wi-Fi & device status")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Update over USB/ }),
    ).toBeNull();
  });

  it("drops the resend tick when the device already has this exact scene set", () => {
    // assigned == acked and nothing unsaved: a resend would send nothing, so
    // the checkbox goes and only the "already in sync" sentence stays. Same
    // rule on both platforms' cards.
    const inSync = { assigned_checksum: "abc123", scenes_checksum: "abc123" };
    for (const platform of ["esp32", "pi-zero2w"] as const) {
      cleanup();
      render(<FrameDeployPlanDrawer frame={cloudFrame(platform, inSync)} />);
      if (platform === "esp32") {
        fireEvent.click(screen.getByRole("button", { name: /Over the air/ }));
      }
      expect(
        screen.queryByRole("checkbox", { name: /Resend scenes & settings/ }),
      ).toBeNull();
      expect(
        screen.getByText(/already in sync — nothing extra is sent/),
      ).toBeTruthy();
    }
  });

  it("orders the USB path firmware, scene push, then Wi-Fi repair", () => {
    render(<FrameDeployPlanDrawer frame={cloudFrame("esp32")} />);
    fireEvent.click(screen.getByRole("button", { name: /Over USB/ }));

    // 1. The NVS-sparing firmware update, with the same "and the scenes too"
    // tick the over-the-air firmware card offers…
    expect(
      screen.getByRole("button", { name: /Update over USB/ }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("checkbox", { name: /Also push scenes & settings/ })
        .length,
    ).toBeGreaterThan(0);
    // 2. …the same scene bodies the OTA push sends, over the cable (behind a
    // connect button until a board is attached)…
    expect(screen.getByText("Push scenes & settings")).toBeTruthy();
    expect(
      screen.getByText(/Connect the board over USB to push scenes/),
    ).toBeTruthy();
    // 3. …and WebSerial provisioning, the only repair channel for a board
    // whose Wi-Fi credentials are wrong.
    expect(screen.getByText("Wi-Fi & device status")).toBeTruthy();
    // Re-linking a WIPED board is the last card, not a pointer at some other
    // screen: it needs a claim token bound to this frame, so the cloud bundle
    // registers it (CloudFrameUsbRelink) — absent in this shared-SPA harness,
    // which registers no panels.
    expect(
      screen.queryByText(/re-connect it from the "Add\s?frame" panel/i),
    ).toBeNull();
  });

  it("lands a frame no board has enrolled as straight on the USB view", () => {
    render(
      <FrameDeployPlanDrawer
        frame={cloudFrame("esp32", { status: "pending" })}
      />,
    );

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
      "Flash latest release",
      "Copy flash command",
      "Update over the air",
    ]) {
      expect(screen.queryByText(backendOnly)).toBeNull();
    }
  });

  it("leaves a cloud Pi frame the scene push and the FrameOS update, without the esp32 surfaces", () => {
    render(<FrameDeployPlanDrawer frame={cloudFrame("pi-zero2w")} />);

    expect(
      screen.getByRole("button", { name: /Push scenes & settings/ }),
    ).toBeTruthy();
    // The same notify_update_available nudge the esp32 gets, with Pi wording:
    // the device runs its own signed release upgrade (frameos/upgrade.nim).
    // Constant label; the checkbox owns "and the scenes too".
    expect(
      screen.getByRole("button", { name: /Upgrade FrameOS/ }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Resend scenes & settings/ }),
    );
    expect(
      screen.getByRole("button", { name: /Upgrade FrameOS/ }),
    ).toBeTruthy();
    // USB provisioning and the hardware panel stay esp32-profile surfaces: a
    // cloud Pi has no serial console to provision over and no enrollment
    // hardware report to render.
    expect(screen.queryByRole("button", { name: /Over the air/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Over USB/ })).toBeNull();
    expect(screen.queryByText("Wi-Fi & device status")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Upgrade firmware/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Update over USB/ }),
    ).toBeNull();
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
