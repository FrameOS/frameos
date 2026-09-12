// @vitest-environment jsdom
//
// The deploy dialog for a frame the backend reaches only over its admin API:
// an adopted generic Buildroot card with no FrameOS Remote, no SSH key and
// no password. The SSH/Remote deploy cannot connect to it, so the drawer
// gives it the cloud-shaped dialog — what is on the frame, then the two
// things that change it — instead of the backend's plan, recommendation,
// build options and fast/full footer.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// apiFetch itself resolves a project id over the network in backend mode and
// answers everything with a synthetic 404 under the no-backend flag; routing
// the calls here keeps the harness offline and lets the test answer by path.
const fetchMock = vi.hoisted(() => vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init) };
});

import { initKea } from "../../../../../../frontend/src/initKea";
import { FrameDeployPlanDrawer } from "../../../../../../frontend/src/scenes/workspace/FrameDeployPlanDrawer";
import type { FrameType } from "../../../../../../frontend/src/types";

const scenes = [
  { id: "scene-1", name: "Clock", nodes: [], edges: [], fields: [] },
] as unknown as FrameType["scenes"];

function adoptedCard(overrides: Partial<FrameType> = {}): FrameType {
  const card = {
    id: 14,
    project_id: 1,
    name: "Kitchen card",
    mode: "buildroot",
    buildroot: { platform: "raspberry-pi-64", adopted: true },
    frame_admin_auth: { enabled: true, user: "admin", pass: "secret" },
    agent: { agentEnabled: false, agentRunCommands: false },
    ssh_keys: [],
    ssh_pass: "",
    frame_host: "10.0.0.42",
    frame_port: 8787,
    frame_access_key: "",
    frame_access: "private",
    ssh_port: 22,
    server_host: "backend.local",
    server_port: 8989,
    status: "ready",
    interval: 300,
    metrics_interval: 60,
    scaling_mode: "contain",
    background_color: "#000000",
    device: "framebuffer",
    assets_path: "/srv/assets",
    scenes,
    last_successful_deploy_at: "2026-09-12T08:34:00Z",
  };
  // Deployed as it is now, on an older release: the version is the frame's
  // to report, the rest is in sync.
  return {
    ...card,
    last_successful_deploy: { ...card, frameos_version: "2026.9.12" },
    ...overrides,
  } as unknown as FrameType;
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function requestsTo(pattern: RegExp): string[] {
  return fetchMock.mock.calls
    .map(([input, init]) => `${init?.method ?? "GET"} ${requestUrl(input)}`)
    .filter((entry) => pattern.test(entry));
}

let upgradeStatus: Record<string, unknown>;

type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;

beforeEach(() => {
  // No websocket, no first-user probe: the models under test talk to the
  // mocked fetch only.
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  window.history.replaceState({}, "", "/");
  document.body.innerHTML = '<div id="popper"></div><div id="root"></div>';
  upgradeStatus = {
    status: "idle",
    current_version: "2026.9.13",
    latest_version: "2026.9.14",
    update_available: true,
    shell_access: false,
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (/\/device\/upgrade/.test(url)) {
      if (init?.method === "POST") {
        return Response.json({ ...upgradeStatus, status: "starting", message: "queued", update_available: false });
      }
      return Response.json(upgradeStatus);
    }
    if (/\/deploy_plan/.test(url)) {
      return Response.json({
        plan: {
          mode: "combined",
          frame_id: 14,
          frame_name: "Kitchen card",
          build_id: "build",
          previous_frameos_version: upgradeStatus.current_version,
          notes: [],
          fast_deploy: { reload_supported: true, tls_settings_changed: false, action: "http_admin_api" },
          full_deploy: null,
        },
      });
    }
    if (/\/api\/frames\/14$/.test(url)) {
      return Response.json({ frame: adoptedCard() });
    }
    if (/\/commands/.test(url)) {
      return Response.json({ commands: [] });
    }
    if (/\/api\/assets/.test(url)) {
      return Response.json([]);
    }
    if (/\/logs/.test(url)) {
      return Response.json({ logs: [] });
    }
    return Response.json({ frames: [] });
  });
  initKea();
});

afterEach(() => {
  cleanup();
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("the deploy dialog for a frame with admin-API access only", () => {
  it("shows the frame's own version and the two actions, and none of the backend build machinery", async () => {
    render(<FrameDeployPlanDrawer frame={adoptedCard()} />);

    expect(screen.getByText("What's on the frame")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Update FrameOS/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Deploy scenes & settings/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Refresh/ })).toBeTruthy();
    // The card can still be rewritten or moved: last, and one row.
    expect(screen.getByRole("button", { name: /Download SD card/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Run a script/ })).toBeTruthy();

    // Opening asks the frame itself (and records what it answers on the
    // backend), so the version here is never a stale deploy baseline.
    await waitFor(() => {
      expect(requestsTo(/GET .*\/api\/frames\/14\/device\/upgrade\?check=1$/)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByText("2026.9.13 → 2026.9.14")).toBeTruthy();
    });
    expect(screen.getByText(/A newer release is published/)).toBeTruthy();
    expect(screen.getByText("1 scene")).toBeTruthy();

    for (const gone of [
      "No shell on this frame",
      "Check for updates",
      "Pending changes",
      "advanced: installation mode",
      "Fast deploy",
      "Full deploy",
      "Retry",
    ]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(screen.queryByText(/^Suggested:/)).toBeNull();
    expect(screen.queryByText(/Last upgrade/)).toBeNull();
    // Like the cloud: the actions sit in the body, the footer only closes.
    expect(screen.getByText("Close")).toBeTruthy();
  });

  it("refreshes by asking the frame again, and starts the frame's own update", async () => {
    render(<FrameDeployPlanDrawer frame={adoptedCard()} />);
    await waitFor(() => {
      expect(screen.getByText("2026.9.13 → 2026.9.14")).toBeTruthy();
    });

    upgradeStatus = { ...upgradeStatus, current_version: "2026.9.14", update_available: false };
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => {
      expect(requestsTo(/GET .*\/device\/upgrade\?check=1$/)).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getByText("2026.9.14")).toBeTruthy();
    });
    expect(screen.getByText(/Up to date with the latest release/)).toBeTruthy();
    // Nothing to install: the button says so instead of vanishing.
    expect((screen.getByRole("button", { name: /Update FrameOS/ }) as HTMLButtonElement).disabled).toBe(true);

    upgradeStatus = { ...upgradeStatus, current_version: "2026.9.13", update_available: true };
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /Update FrameOS/ }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: /Update FrameOS/ }));
    await waitFor(() => {
      expect(requestsTo(/POST .*\/api\/frames\/14\/device\/upgrade$/)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Updating…/ })).toBeTruthy();
    });
    expect(screen.getByText(/Updating: starting — queued/)).toBeTruthy();
  });

  it("hands a Buildroot frame the install script only on request", () => {
    window.history.replaceState({}, "", "/?deployView=script");
    render(<FrameDeployPlanDrawer frame={adoptedCard()} />);
    fireEvent.click(screen.getByRole("button", { name: /Run a script/ }));

    expect(screen.getByText("Install with a script")).toBeTruthy();
    expect(screen.getByText(/Moves this frame to a Debian or Ubuntu device/)).toBeTruthy();
    // Opening the view must not mint the Remote secret on its own.
    expect(requestsTo(/frame_bootstrap/)).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Generate command/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copy command/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Regenerate/ })).toBeNull();
  });
});
