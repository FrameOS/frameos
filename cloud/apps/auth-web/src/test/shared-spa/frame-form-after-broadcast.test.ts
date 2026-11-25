// @vitest-environment jsdom
//
// A frame a tab first hears of through the `new_frame` broadcast holds no
// secrets: the backend strips them from every broadcast and keeps them behind
// the per-frame GET (backend app/utils/frame_secrets.py). The tab's frameLogic
// (the frames home mounts one per card) builds its form from that row, and the
// full row comes a moment later (the create or adopt request's answer, a GET).
// The form must follow it: the form still matches the row it was built from,
// so nothing the user typed is in the way. It did not, because the form had
// filled in `frame_admin_auth.pass: ''` where the broadcast had no `pass`, and
// that read as a user edit: an adopted ESP32 opened with Frame access key,
// Frame admin auth, HTTPS, SSH password, Server API key and Remote settings
// "unsaved" and "pending" (2026-11-25, frame 76).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { getContext } from "../../../../../../frontend/node_modules/kea";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string, init?: RequestInit) => apiFetchMock(input, init) };
});

import { initKea } from "../../../../../../frontend/src/initKea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import { socketLogic } from "../../../../../../frontend/src/scenes/socketLogic";
import { frameLogic } from "../../../../../../frontend/src/scenes/frame/frameLogic";
import type { FrameType } from "../../../../../../frontend/src/types";

type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;

let frameNumber = 700;

function fullRow(id: number): FrameType {
  const deployed = {
    name: "pulk",
    mode: "embedded",
    frame_host: "10.0.0.42",
    frame_port: 80,
    frame_access: "private",
    server_host: "10.0.0.5",
    server_port: 8989,
    ssh_pass: null,
    frame_admin_auth: { enabled: true, user: "admin" },
    https_proxy: { enable: false, port: 8443, expose_only_port: true, certs: { server: "CERT", client_ca: "CA" } },
    agent: { agentEnabled: false, agentRunCommands: false, deployWithAgent: false },
    device: "waveshare.EPD_7in3e",
    embedded: { platform: "esp32-s3" },
    scenes: [],
    secret_fingerprints: {
      server_api_key: "f1",
      frame_access_key: "f2",
      "https_proxy.certs.server_key": "f3",
      "agent.agentSharedSecret": "f4",
      "frame_admin_auth.pass": "f5",
    },
  };
  return {
    ...deployed,
    id,
    project_id: 1,
    status: "starting",
    server_api_key: "server-key",
    frame_access_key: "access-key",
    frame_admin_auth: { enabled: true, user: "admin", pass: "minted" },
    https_proxy: { ...deployed.https_proxy, certs: { ...deployed.https_proxy.certs, server_key: "KEY" } },
    agent: { ...deployed.agent, agentSharedSecret: "shared" },
    last_successful_deploy: deployed,
    secret_fingerprints: deployed.secret_fingerprints,
  } as unknown as FrameType;
}

/** What websocket_frame_payload makes of the row: no top-level secrets, the
 * secret leaves out of the blocks that hold them. */
function broadcastOf(row: FrameType): FrameType {
  type Block = Record<string, unknown>;
  const { ssh_pass: _ssh, server_api_key: _api, frame_access_key: _access, ...rest } = row as unknown as Block;
  const { pass: _pass, ...auth } = rest["frame_admin_auth"] as Block;
  const httpsProxy = rest["https_proxy"] as Block;
  const { server_key: _key, ...certs } = httpsProxy["certs"] as Block;
  const { agentSharedSecret: _secret, ...agent } = rest["agent"] as Block;
  return {
    ...rest,
    frame_admin_auth: auth,
    https_proxy: { ...httpsProxy, certs },
    agent,
  } as unknown as FrameType;
}

beforeEach(() => {
  frameNumber += 1;
  // Keeps socketLogic from dialing a WebSocket jsdom does not have.
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (input) =>
    String(input) === "/api/frames" ? Response.json({ frames: [] }) : Response.json({})
  );
  initKea();
});

afterEach(() => {
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("frame form after a secret-less broadcast", () => {
  it("follows the full row, so nothing reads as unsaved or pending", async () => {
    // Before the fix: Frame access key, Frame admin auth, HTTPS, SSH password,
    // Server API key and Remote settings, in both lists.
    const id = frameNumber;
    const row = fullRow(id);
    framesModel.mount();
    // The list the tab loaded before the frame existed.
    await waitFor(() => expect(framesModel.values.framesEverLoaded).toBe(true));
    getContext().store.dispatch({ type: socketLogic.actionTypes.newFrame, payload: { frame: broadcastOf(row) } });
    const logic = frameLogic({ frameId: id as unknown as FrameType["id"] });
    logic.mount();
    await waitFor(() => expect(logic.values.frameForm?.id).toBe(id));

    // The adopt (or create) request's answer: the row with its secrets.
    framesModel.actions.addFrame(row);
    await waitFor(() => expect(logic.values.frame?.server_api_key).toBe("server-key"));

    expect(logic.values.unsavedChanges).toBe(false);
    expect(logic.values.unsavedChangeDetails.map((change) => change.label)).toEqual([]);
    // The release the frame runs is its own question (versions.json).
    expect(
      logic.values.deployChangeDetails.filter((change) => !change.frameosVersionChange).map((change) => change.label)
    ).toEqual([]);
    expect(logic.values.frameForm.server_api_key).toBe("server-key");
  });
});
