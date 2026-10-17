// @vitest-environment jsdom
//
// The frame's LAN access switch (docs/lan-access.md): turning it on asks the
// frame to draw a code on its panel and sends the code back; turning it off
// goes straight through. The backend and the cloud serve the same two routes;
// the frame's own admin page talks to the device's local-access routes and is
// normalized to the same states.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init) };
});

import { initKea } from "../../../../../../frontend/src/initKea";
import { BindLogic } from "../../../../../../frontend/node_modules/kea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { frameLogic } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import { FrameSettings } from "../../../../../../frontend/src/scenes/frame/panels/FrameSettings/FrameSettings";
import {
  lanAccessErrorMessage,
  lanAccessLogic,
} from "../../../../../../frontend/src/scenes/frame/panels/FrameSettings/lanAccessLogic";
import { framePayload } from "../../../../../../frontend/src/scenes/frames/newFrameForm";
import { pendingCommandLabel } from "../../../../../../frontend/src/scenes/workspace/framePendingCommandsLogic";
import { isProjectScopedApiPath } from "../../../../../../frontend/src/utils/projectApi";
import type { FrameType, NewFrameFormType } from "../../../../../../frontend/src/types";

type TestWindow = Window & {
  FRAMEOS_APP_CONFIG?: Record<string, unknown>;
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as TestWindow;

let frameRow: FrameType;
let routes: Record<string, (body: Record<string, unknown>) => Response>;

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function posts(): { path: string; body: Record<string, unknown> }[] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([input, init]) => ({
      path: requestUrl(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    }));
}

function makeFrame(overrides: Partial<FrameType> = {}): FrameType {
  return {
    id: 1,
    project_id: 1,
    name: "Kitchen",
    frame_host: "10.0.0.5",
    frame_port: 8787,
    frame_access_key: "",
    frame_access: "private",
    ssh_port: 22,
    server_port: 8989,
    status: "ready",
    interval: 300,
    metrics_interval: 60,
    scaling_mode: "contain",
    background_color: "#000000",
    device: "waveshare.EPD_7in5_V2",
    lan_access: false,
    ...overrides,
  } as unknown as FrameType;
}

beforeEach(() => {
  // With apiFetch mocked the flag only keeps socketLogic from opening a
  // WebSocket jsdom cannot.
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  // headlessui's Dialog measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  document.body.innerHTML = '<div id="popper"></div><div id="root"></div>';
  frameRow = makeFrame();
  routes = {};
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const method = init?.method ?? "GET";
    const path = requestUrl(input);
    const handler = routes[`${method} ${path}`];
    if (handler) {
      return handler(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    }
    if (method === "GET" && path === `/api/frames/${frameRow.id}`) {
      return Response.json({ frame: frameRow });
    }
    if (method === "GET" && path === "/api/frames") {
      return Response.json({ frames: [frameRow] });
    }
    if (method === "GET" && path.startsWith("/api/assets")) {
      return Response.json([]);
    }
    if (method === "GET" && path.endsWith("/logs")) {
      return Response.json({ logs: [] });
    }
    return Response.json({}, { status: 404 });
  });
  initKea();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete testWindow.FRAMEOS_APP_CONFIG;
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

function mountLogic(frame: FrameType = frameRow) {
  frameRow = frame;
  framesModel.mount();
  framesModel.actions.loadFramesSuccess({ [String(frame.id)]: frame } as Record<string, FrameType>);
  const logic = lanAccessLogic({ frameId: frame.id });
  logic.mount();
  return logic;
}

describe("LAN access on the backend and the cloud", () => {
  // No config: the backend's SPA. The cloud calls the same paths, and the real
  // apiFetch project-scopes them on the backend the way restart and reboot are.
  it("calls the frame routes, which the backend project-scopes", () => {
    expect(isProjectScopedApiPath("/api/frames/1/lan_access")).toBe(true);
    expect(isProjectScopedApiPath("/api/frames/1/lan_access/challenge")).toBe(true);
  });

  for (const plane of ["backend", "cloud"] as const) {
    it(`${plane}: shows a code, takes it back and mirrors the result`, async () => {
      if (plane === "cloud") {
        testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
      }
      routes["POST /api/frames/1/lan_access/challenge"] = () =>
        Response.json({ status: "shown", expires_in_seconds: 300 });
      routes["POST /api/frames/1/lan_access"] = (body) => {
        frameRow = { ...frameRow, lan_access: body.enabled === true };
        return Response.json({ status: "applied", lan_access: body.enabled });
      };
      const logic = mountLogic();
      expect(logic.values.lanAccess).toBe(false);

      logic.actions.switchChanged(true);
      expect(logic.values.phase).toBe("start");
      expect(posts()).toEqual([]);

      logic.actions.showCode();
      expect(logic.values.phase).toBe("requesting");
      await waitFor(() => expect(logic.values.phase).toBe("shown"));

      // Pasted with spaces, typed with letters: only six digits count.
      logic.actions.setCode("12 34 5x6789");
      expect(logic.values.code).toBe("123456");
      expect(logic.values.canConfirm).toBe(true);

      logic.actions.confirmCode();
      await waitFor(() => expect(logic.values.phase).toBe("done"));
      expect(posts()).toEqual([
        { path: "/api/frames/1/lan_access/challenge", body: {} },
        { path: "/api/frames/1/lan_access", body: { enabled: true, code: "123456" } },
      ]);
      expect(framesModel.values.frames[1]?.lan_access).toBe(true);
      expect(logic.values.lanAccess).toBe(true);
    });
  }

  it("turns LAN access off with no code and no dialog", async () => {
    routes["POST /api/frames/1/lan_access"] = (body) => {
      frameRow = { ...frameRow, lan_access: body.enabled === true };
      return Response.json({ status: "applied", lan_access: false });
    };
    const logic = mountLogic(makeFrame({ lan_access: true }));

    logic.actions.switchChanged(false);
    expect(logic.values.phase).toBe("closed");
    expect(logic.values.disabling).toBe(true);
    await waitFor(() => expect(logic.values.lanAccess).toBe(false));
    expect(posts()).toEqual([{ path: "/api/frames/1/lan_access", body: { enabled: false } }]);
  });

  it("tells the owner when a sleeping frame will show the code, and keeps the input", async () => {
    routes["POST /api/frames/1/lan_access/challenge"] = () => Response.json({ status: "queued" });
    routes["POST /api/frames/1/lan_access"] = () => Response.json({ status: "queued" });
    const logic = mountLogic();

    logic.actions.switchChanged(true);
    logic.actions.showCode();
    await waitFor(() => expect(logic.values.phase).toBe("queued"));
    logic.actions.setCode("654321");
    expect(logic.values.canConfirm).toBe(true);

    logic.actions.confirmCode();
    await waitFor(() => expect(logic.values.phase).toBe("applyQueued"));
    // Nothing applied yet: the switch stays off until the frame reports it.
    expect(logic.values.lanAccess).toBe(false);
    logic.actions.closeModal();
    expect(logic.values.pendingNote).toBe("The frame checks the code when it wakes up.");
  });

  it("maps the device's tokens to plain copy and clears a wrong code", async () => {
    routes["POST /api/frames/1/lan_access/challenge"] = () =>
      Response.json({ status: "shown", expires_in_seconds: 300 });
    routes["POST /api/frames/1/lan_access"] = () => Response.json({ error: "invalid_code" }, { status: 403 });
    const logic = mountLogic();

    logic.actions.switchChanged(true);
    logic.actions.showCode();
    await waitFor(() => expect(logic.values.phase).toBe("shown"));
    logic.actions.setCode("000000");
    logic.actions.confirmCode();
    await waitFor(() => expect(logic.values.error?.token).toBe("invalid_code"));
    expect(logic.values.error?.message).toBe("That code does not match the one on the frame.");
    expect(logic.values.phase).toBe("shown");
    expect(logic.values.code).toBe("");
    // Typing again answers it.
    logic.actions.setCode("1");
    expect(logic.values.error).toBeNull();
  });

  it("prefers the plane's own detail, nested or not, and falls back per token", async () => {
    expect(lanAccessErrorMessage("code_expired")).toBe("The code expired. Show a new one.");
    expect(lanAccessErrorMessage("too_many_attempts")).toBe("Too many wrong codes. Show a new one.");
    expect(lanAccessErrorMessage("unsupported")).toBe("Update this frame's FrameOS first.");
    expect(lanAccessErrorMessage("no_panel")).toBe(
      "This frame has no screen to show a code on. Choose LAN access when you set the frame up instead.",
    );
    expect(lanAccessErrorMessage("timeout", null, 504)).toMatch(/Could not reach the frame/);
    expect(lanAccessErrorMessage("invalid_code", "Wrong code, 3 tries left.")).toBe("Wrong code, 3 tries left.");

    routes["POST /api/frames/1/lan_access/challenge"] = () =>
      Response.json({ detail: { detail: "This frame has no screen.", error: "no_panel" } }, { status: 409 });
    const logic = mountLogic();
    logic.actions.switchChanged(true);
    logic.actions.showCode();
    await waitFor(() => expect(logic.values.error?.token).toBe("no_panel"));
    expect(logic.values.error?.message).toBe("This frame has no screen.");
    // Asking again cannot help a frame with nothing to draw on.
    expect(logic.values.canRequestCode).toBe(false);
    expect(logic.values.phase).toBe("start");
  });

  it("leaves an unknown value alone", () => {
    const logic = mountLogic(makeFrame({ lan_access: null }));
    expect(logic.values.lanAccess).toBeNull();
    logic.actions.switchChanged(true);
    logic.actions.switchChanged(false);
    expect(logic.values.phase).toBe("closed");
    expect(posts()).toEqual([]);
  });
});

describe("LAN access on the frame's own admin page", () => {
  beforeEach(() => {
    testWindow.FRAMEOS_APP_CONFIG = { frameMode: "frame", frameAdminMode: true };
  });

  it("uses the device's local-access routes and normalizes their answers", async () => {
    routes["POST /api/network/local-access/challenge"] = () =>
      Response.json({ status: "ok", codeLength: 6, expiresInSeconds: 300 });
    routes["POST /api/network/local-access"] = (body) => {
      frameRow = { ...frameRow, lan_access: body.enabled === true };
      return Response.json({
        allowLocalNetworkAccess: body.enabled === true,
        allowShellApps: false,
        challengePending: false,
        challengeSecondsLeft: 0,
      });
    };
    const logic = mountLogic();

    logic.actions.switchChanged(true);
    logic.actions.showCode();
    await waitFor(() => expect(logic.values.phase).toBe("shown"));
    logic.actions.setCode("246810");
    logic.actions.confirmCode();
    await waitFor(() => expect(logic.values.phase).toBe("done"));
    expect(logic.values.lanAccess).toBe(true);

    logic.actions.closeModal();
    logic.actions.switchChanged(false);
    await waitFor(() => expect(logic.values.lanAccess).toBe(false));

    expect(posts()).toEqual([
      { path: "/api/network/local-access/challenge", body: { scope: "localNetwork" } },
      { path: "/api/network/local-access", body: { enabled: true, code: "246810", scope: "localNetwork" } },
      { path: "/api/network/local-access", body: { enabled: false, scope: "localNetwork" } },
    ]);
  });

  it("reads the device's `{detail, error}` refusals", async () => {
    routes["POST /api/network/local-access/challenge"] = () => Response.json({ status: "ok" });
    routes["POST /api/network/local-access"] = () =>
      Response.json({ error: "too_many_attempts" }, { status: 403 });
    const logic = mountLogic();

    logic.actions.switchChanged(true);
    logic.actions.showCode();
    await waitFor(() => expect(logic.values.phase).toBe("shown"));
    logic.actions.setCode("111111");
    logic.actions.confirmCode();
    await waitFor(() => expect(logic.values.error?.token).toBe("too_many_attempts"));
    expect(logic.values.error?.message).toBe("Too many wrong codes. Show a new one.");
    // A new code is one click away.
    expect(logic.values.canRequestCode).toBe(true);
  });
});

describe("the LAN access section in the settings panel", () => {
  function renderPanel(frame: FrameType) {
    testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true };
    frameRow = frame;
    framesModel.mount();
    framesModel.actions.loadFramesSuccess({ [String(frame.id)]: frame } as Record<string, FrameType>);
    render(
      <BindLogic logic={frameLogic} props={{ frameId: frame.id }}>
        <FrameSettings />
      </BindLogic>,
    );
    const heading = document.getElementById("frame-settings-lan-access");
    expect(heading?.textContent).toBe("LAN access");
    // The section's body: the switch, its help and notes.
    return heading!.nextElementSibling as HTMLElement;
  }

  const cloudPi = { managed_by: "cloud", hardware: { platform: "raspberry-pi-64" }, frameos_version: "2026.10.17" };

  it("walks the code dialog: show the code, type it, turn on", async () => {
    routes["POST /api/frames/1/lan_access/challenge"] = () =>
      Response.json({ status: "shown", expires_in_seconds: 300 });
    routes["POST /api/frames/1/lan_access"] = () => {
      frameRow = { ...frameRow, lan_access: true };
      return Response.json({ status: "applied", lan_access: true });
    };
    const section = renderPanel(makeFrame({ ...cloudPi, lan_access: false } as Partial<FrameType>));
    expect(section.textContent).toContain("Off");
    expect(section.textContent).toContain("Lets scenes reach devices on your home network");

    fireEvent.click(within(section).getByRole("switch"));
    fireEvent.click(await screen.findByRole("button", { name: "Show code on the frame" }));
    const input = await screen.findByLabelText("Code from the frame");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(screen.getByText("Enter the code showing on your frame.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "135790" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));

    expect(await screen.findByText("LAN access is on.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(section.textContent).toContain("On"));
    expect(posts().map((post) => post.path)).toEqual([
      "/api/frames/1/lan_access/challenge",
      "/api/frames/1/lan_access",
    ]);
  });

  it("says a cloud frame must update first when it does not report LAN access", () => {
    const section = renderPanel(makeFrame({ ...cloudPi, lan_access: null } as Partial<FrameType>));
    expect(within(section).getByTestId("lan-access-unknown").textContent).toMatch(/Update its FrameOS first/);
    const button = section.querySelector("button");
    expect(button?.disabled).toBe(true);
    fireEvent.click(within(section).getByRole("switch"));
    expect(screen.queryByTestId("lan-access-modal")).toBeNull();
  });
});

describe("LAN access when a frame is added", () => {
  const base: NewFrameFormType = { name: "Kitchen", frame_host: "pi@10.0.0.5", server_host: "10.0.0.2" };

  it("is sent off for every install method unless the switch was turned on", () => {
    for (const install_method of ["ssh", "script", "sd_card", "embedded"] as const) {
      expect(framePayload({ ...base, install_method }).lan_access, install_method).toBe(false);
      expect(framePayload({ ...base, install_method, lan_access: true }).lan_access, install_method).toBe(true);
    }
  });
});

describe("pending commands", () => {
  it("names the two LAN access verbs", () => {
    const command = { id: "c1", status: "pending", created_at: null, expires_at: null, sent_at: null };
    expect(pendingCommandLabel({ ...command, type: "lan_access_challenge" })).toBe("Show LAN access code");
    expect(pendingCommandLabel({ ...command, type: "lan_access_set" })).toBe("Change LAN access");
  });
});
