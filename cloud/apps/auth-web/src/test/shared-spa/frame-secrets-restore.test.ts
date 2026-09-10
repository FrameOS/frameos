import { describe, expect, it } from "vitest";
import { restoreDeployedSecrets } from "../../../../../../frontend/src/utils/frameSecrets";

// The deploy baseline (frame.last_successful_deploy) carries no secrets, only
// an HMAC fingerprint per secret leaf; the frame row carries the current
// fingerprints beside its current values. restoreDeployedSecrets() fills a
// secret back into the baseline wherever the two fingerprints agree, so an
// unchanged secret compares equal ("nothing pending") and a rotated one
// shows as changed since the deploy. Pins that contract leaf by leaf.

type Baseline = Record<string, unknown> & { secret_fingerprints?: Record<string, string> };

const fingerprints = {
  ssh_pass: "fp-ssh",
  "network.wifiPassword": "fp-wifi",
  "network.wifiHotspotPassword": "fp-hotspot",
  "frame_admin_auth.pass": "fp-admin",
  "mountpoints.items.0.password": "fp-mount-0",
  "mountpoints.items.1.password": "fp-mount-1",
  "https_proxy.certs.server_key": "fp-key",
  "agent.agentSharedSecret": "fp-agent",
};

function baseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    name: "Kitchen",
    ssh_user: "pi",
    network: { wifiSSID: "home", wifiHotspotSsid: "FrameOS-Setup" },
    frame_admin_auth: { user: "admin" },
    mountpoints: { items: [{ path: "/a", username: "u" }, { path: "/b", username: "v" }] },
    https_proxy: { enable: true, certs: { server: "CERT" } },
    agent: { agentEnabled: true },
    secret_fingerprints: { ...fingerprints },
    ...overrides,
  };
}

function current(overrides: Record<string, unknown> = {}) {
  return {
    name: "Kitchen",
    ssh_user: "pi",
    ssh_pass: "raspberry",
    network: { wifiSSID: "home", wifiPassword: "hunter2", wifiHotspotSsid: "FrameOS-Setup", wifiHotspotPassword: "frame1234" },
    frame_admin_auth: { user: "admin", pass: "adminpw" },
    mountpoints: {
      items: [
        { path: "/a", username: "u", password: "mp0" },
        { path: "/b", username: "v", password: "mp1" },
      ],
    },
    https_proxy: { enable: true, certs: { server: "CERT", server_key: "KEY" } },
    agent: { agentEnabled: true, agentSharedSecret: "shared" },
    secret_fingerprints: { ...fingerprints },
    ...overrides,
  };
}

describe("restoreDeployedSecrets", () => {
  it("pins the baseline to the row when every fingerprint agrees: the two compare equal, secret by secret", () => {
    const restored = restoreDeployedSecrets(baseline(), current() as never) as Record<string, unknown>;
    const { secret_fingerprints: _fingerprints, ...row } = current();
    expect(restored).toEqual(row);
    expect(restored).not.toHaveProperty("secret_fingerprints");
  });

  it("leaves a rotated secret out, so only that leaf reads as changed since the deploy", () => {
    const rotated = current({
      secret_fingerprints: { ...fingerprints, "network.wifiPassword": "fp-wifi-2" },
    });
    const restored = restoreDeployedSecrets(baseline(), rotated as never) as {
      network: Record<string, unknown>;
      ssh_pass?: string;
    };
    expect(restored.network).toEqual({ wifiSSID: "home", wifiHotspotSsid: "FrameOS-Setup", wifiHotspotPassword: "frame1234" });
    expect(restored.ssh_pass).toBe("raspberry");
  });

  it("fills list leaves by index and skips an index whose fingerprint differs", () => {
    const rotated = current({
      secret_fingerprints: { ...fingerprints, "mountpoints.items.1.password": "fp-mount-1-new" },
    });
    const restored = restoreDeployedSecrets(baseline(), rotated as never) as {
      mountpoints: { items: Record<string, unknown>[] };
    };
    expect(restored.mountpoints.items[0]).toEqual({ path: "/a", username: "u", password: "mp0" });
    expect(restored.mountpoints.items[1]).toEqual({ path: "/b", username: "v" });
  });

  it("skips a secret the baseline never fingerprinted (deployed before it existed) and an empty current value", () => {
    const { "agent.agentSharedSecret": _agent, ...withoutAgent } = fingerprints;
    const restored = restoreDeployedSecrets(
      baseline({ secret_fingerprints: withoutAgent }),
      current({ ssh_pass: "" }) as never,
    ) as { agent: Record<string, unknown>; ssh_pass?: string };
    expect(restored.agent).toEqual({ agentEnabled: true });
    expect(restored).not.toHaveProperty("ssh_pass");
  });

  it("returns a snapshot without fingerprints unchanged (a backend that predates them)", () => {
    const legacy = { name: "Old", network: { wifiSSID: "home" } };
    expect(restoreDeployedSecrets(legacy, current() as never)).toBe(legacy);
    expect(restoreDeployedSecrets(null, current() as never)).toBeNull();
    expect(restoreDeployedSecrets(undefined, current() as never)).toBeUndefined();
  });

  it("never mutates the stored snapshot object", () => {
    const snapshot = baseline();
    const frozenNetwork = { ...(snapshot.network as Record<string, unknown>) };
    restoreDeployedSecrets(snapshot, current() as never);
    expect(snapshot.network).toEqual(frozenNetwork);
    expect(snapshot).toHaveProperty("secret_fingerprints");
    expect((snapshot.mountpoints as { items: Record<string, unknown>[] }).items[0]).not.toHaveProperty("password");
  });
});
