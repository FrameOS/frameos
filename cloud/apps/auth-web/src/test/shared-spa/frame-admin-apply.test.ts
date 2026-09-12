import { describe, expect, it } from "vitest";
import {
  describeFrameSaveApply,
  frameOriginAfterApply,
  listenerReachableFrom,
  parseFrameSaveApply,
  type FrameApplyListener,
} from "../../../../../../frontend/src/scenes/frame/frameAdminApply";

// On a standalone frame the settings page is served by the frame itself. A
// save that changes the port, turns HTTPS on or off, or makes HTTPS the only
// way in moves the page from under the user; the device reports the sockets
// it now answers on and the page follows. These pin the "stay or go" rules.

const plain = (port: number, address = "0.0.0.0"): FrameApplyListener => ({ address, port, tls: false });
const tls = (port: number, address = "0.0.0.0"): FrameApplyListener => ({ address, port, tls: true });
const at = (protocol: string, hostname: string, port: string) => ({ protocol, hostname, port });

describe("frameOriginAfterApply", () => {
  it("stays when the current scheme and port are still served", () => {
    expect(frameOriginAfterApply(at("http:", "10.8.0.62", "8787"), [plain(8787)])).toBeNull();
    // A second listener coming up is not a reason to move.
    expect(frameOriginAfterApply(at("http:", "10.8.0.62", "8787"), [plain(8787), tls(8443)])).toBeNull();
    expect(frameOriginAfterApply(at("https:", "10.8.0.62", "8443"), [plain(8787), tls(8443)])).toBeNull();
  });

  it("follows a port change, keeping the scheme", () => {
    expect(frameOriginAfterApply(at("http:", "10.8.0.62", "8787"), [plain(9000)])).toBe("http://10.8.0.62:9000");
    expect(frameOriginAfterApply(at("https:", "frame.local", "8443"), [plain(8787), tls(9443)])).toBe(
      "https://frame.local:9443",
    );
  });

  it("crosses schemes only when its own is gone", () => {
    // HTTPS switched off under an https page.
    expect(frameOriginAfterApply(at("https:", "10.8.0.62", "8443"), [plain(8787)])).toBe("http://10.8.0.62:8787");
    // HTTPS made the only way in: plain HTTP moved to loopback.
    expect(frameOriginAfterApply(at("http:", "10.8.0.62", "8787"), [plain(8787, "127.0.0.1"), tls(8443)])).toBe(
      "https://10.8.0.62:8443",
    );
  });

  it("omits a scheme's default port", () => {
    expect(frameOriginAfterApply(at("http:", "10.8.0.62", "8787"), [tls(443)])).toBe("https://10.8.0.62");
    expect(frameOriginAfterApply(at("https:", "10.8.0.62", ""), [tls(443)])).toBeNull();
    expect(frameOriginAfterApply(at("https:", "10.8.0.62", ""), [plain(80)])).toBe("http://10.8.0.62");
  });

  it("stays when nothing reachable is reported", () => {
    // An older frame, or listeners bound to another address entirely.
    expect(frameOriginAfterApply(at("http:", "10.8.0.62", "8787"), [])).toBeNull();
    expect(frameOriginAfterApply(at("http:", "10.8.0.62", "8787"), [plain(9000, "192.168.1.5")])).toBeNull();
  });

  it("keeps IPv6 hosts bracketed", () => {
    expect(frameOriginAfterApply(at("http:", "[fe80::1]", "8787"), [plain(9000)])).toBe("http://[fe80::1]:9000");
  });
});

describe("listenerReachableFrom", () => {
  it("treats a wildcard bind as reachable from anywhere", () => {
    expect(listenerReachableFrom(plain(8787, "0.0.0.0"), "10.8.0.62")).toBe(true);
    expect(listenerReachableFrom(plain(8787, ""), "frame.local")).toBe(true);
  });
  it("treats a loopback bind as reachable only from the frame itself", () => {
    expect(listenerReachableFrom(plain(8787, "127.0.0.1"), "10.8.0.62")).toBe(false);
    expect(listenerReachableFrom(plain(8787, "127.0.0.1"), "localhost")).toBe(true);
    expect(listenerReachableFrom(plain(8787, "127.0.0.1"), "127.0.0.1")).toBe(true);
  });
  it("matches a specific bind address to the host in the URL", () => {
    expect(listenerReachableFrom(plain(8787, "10.8.0.62"), "10.8.0.62")).toBe(true);
    expect(listenerReachableFrom(plain(8787, "10.8.0.62"), "10.8.0.63")).toBe(false);
  });
});

describe("parseFrameSaveApply", () => {
  it("reads the device's apply block and tolerates its absence", () => {
    expect(parseFrameSaveApply({ message: "ok" })).toBeNull();
    expect(parseFrameSaveApply(null)).toBeNull();
    expect(
      parseFrameSaveApply({
        apply: {
          runtime: "restart",
          listeners: [{ address: "0.0.0.0", port: 8787, tls: false }, { bogus: true }],
          listeners_changed: true,
          system: ["timezone", 42],
        },
      }),
    ).toEqual({
      runtime: "restart",
      listeners: [{ address: "0.0.0.0", port: 8787, tls: false }],
      listeners_changed: true,
      system: ["timezone"],
    });
    expect(parseFrameSaveApply({ apply: { runtime: "bogus" } })).toEqual({
      runtime: "none",
      listeners: [],
      listeners_changed: false,
      system: [],
    });
  });
});

describe("describeFrameSaveApply", () => {
  it("says what the frame is doing beyond writing the file", () => {
    expect(describeFrameSaveApply(null, null)).toBe("Saved");
    expect(describeFrameSaveApply({ runtime: "reload", listeners: [], listeners_changed: false, system: [] }, null)).toBe(
      "Saved",
    );
    expect(
      describeFrameSaveApply(
        { runtime: "restart", listeners: [], listeners_changed: true, system: ["timezone", "mounts"] },
        "https://10.8.0.62:8443",
      ),
    ).toBe(
      "Saved, restarting FrameOS to apply the display settings, setting the system time zone, mounting the Samba shares, moving to https://10.8.0.62:8443",
    );
  });
});
