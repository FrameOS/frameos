import { describe, expect, it } from "vitest";
import { mergeBroadcastFrame } from "../../../../../../frontend/src/utils/frameSecrets";

// An update_frame broadcast strips the secret leaves out of the blocks it
// sends (backend websocket_frame_payload); the browser merges a sent block
// over its own but keeps the secrets the broadcast left out. Before this the
// whole block was withheld and the workspace never learnt agent.agentVersion
// after a Remote upgrade — "FrameOS Remote 2026.9.3 -> 2026.9.13" stayed in
// the deploy drawer until a page reload (2026-09-12).
describe("mergeBroadcastFrame", () => {
  const existing = {
    id: 4,
    name: "Hall",
    status: "deploying",
    ssh_pass: "raspberry",
    agent: { agentEnabled: true, agentSharedSecret: "shared", agentVersion: "2026.9.3" },
    network: { wifiSSID: "home", wifiPassword: "hunter2", wifiHotspotPassword: "" },
    mountpoints: { enabled: true, items: [{ source: "//nas", password: "p1" }, { source: "//nas2", password: "" }] },
    frame_admin_auth: { enabled: true, user: "admin", pass: "secret" },
  };

  it("takes the broadcast's block and keeps the secret leaves it left out", () => {
    const merged = mergeBroadcastFrame(existing, {
      status: "starting",
      agent: { agentEnabled: true, agentVersion: "2026.9.13", remoteCapabilities: ["shell"] },
    });
    expect(merged.status).toBe("starting");
    expect(merged.agent).toEqual({
      agentEnabled: true,
      agentSharedSecret: "shared",
      agentVersion: "2026.9.13",
      remoteCapabilities: ["shell"],
    });
    // Blocks the broadcast did not carry are the browser's, untouched.
    expect(merged.network).toBe(existing.network);
    expect(merged.ssh_pass).toBe("raspberry");
    // The browser's own block objects are never mutated.
    expect(existing.agent.agentVersion).toBe("2026.9.3");
  });

  it("walks lists and nested blocks", () => {
    const merged = mergeBroadcastFrame(existing, {
      mountpoints: { enabled: true, items: [{ source: "//nas", target: "/mnt" }, { source: "//nas2" }] },
      network: { wifiSSID: "cabin" },
      frame_admin_auth: { enabled: true, user: "owner" },
    });
    expect(merged.mountpoints.items).toEqual([
      { source: "//nas", target: "/mnt", password: "p1" },
      { source: "//nas2" },
    ]);
    expect(merged.network).toEqual({ wifiSSID: "cabin", wifiPassword: "hunter2" });
    expect(merged.frame_admin_auth).toEqual({ enabled: true, user: "owner", pass: "secret" });
  });

  it("does not resurrect a secret into a block the broadcast sent with one", () => {
    const merged = mergeBroadcastFrame(existing, {
      agent: { agentEnabled: true, agentSharedSecret: "rotated" },
    });
    expect(merged.agent).toEqual({ agentEnabled: true, agentSharedSecret: "rotated" });
  });

  it("is a plain merge for a row the browser has not seen", () => {
    expect(mergeBroadcastFrame(undefined, { id: 9, agent: { agentEnabled: false } })).toEqual({
      id: 9,
      agent: { agentEnabled: false },
    });
  });
});
