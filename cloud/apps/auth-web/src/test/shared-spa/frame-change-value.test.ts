import { describe, expect, it } from "vitest";
import { describeFrameChangeValue } from "../../../../../../frontend/src/scenes/frame/frameLogic";

// The deploy drawer lists a pending change by field name only ("Server
// scheme", "Network settings"); the hover on the row says what the deploy
// baseline holds and what the row holds now. Secrets never appear.
describe("describeFrameChangeValue", () => {
  it("uses the settings summary where one exists", () => {
    expect(describeFrameChangeValue("server_scheme", "https")).toBe("https");
    expect(describeFrameChangeValue("server_scheme", undefined)).toBe("Not set");
    expect(describeFrameChangeValue("server_port", 8989)).toBe("8989");
    expect(describeFrameChangeValue("debug", true)).toBe("Enabled");
    expect(describeFrameChangeValue("frame_admin_auth", { enabled: true, user: "admin", pass: "hunter2" })).toBe(
      "Enabled (admin)",
    );
  });

  it("shows only whether a secret is set", () => {
    expect(describeFrameChangeValue("ssh_pass", "raspberry")).toBe("Configured");
    expect(describeFrameChangeValue("server_api_key", "")).toBe("Not set");
  });

  it("renders a settings block as JSON with its secret leaves redacted", () => {
    const text = describeFrameChangeValue("network", {
      wifiSSID: "home",
      wifiPassword: "hunter2",
      wifiHotspotPassword: "",
    });
    expect(text).toBe('{"wifiSSID":"home","wifiPassword":"Configured","wifiHotspotPassword":"Not set"}');
    expect(text).not.toContain("hunter2");

    const mounts = describeFrameChangeValue("mountpoints", {
      enabled: true,
      items: [{ source: "//nas/photos", target: "/mnt/photos", password: "s3cret" }],
    });
    expect(mounts).toBe("1 mountpoint");
    expect(
      describeFrameChangeValue("ssh_keys", [{ id: 1, name: "laptop" }]),
    ).toBe("1 selected");
  });

  it("cuts a long value short", () => {
    const text = describeFrameChangeValue("device_config", undefined);
    expect(text).toBe("Not set");
    const long = describeFrameChangeValue("gpio_buttons", Array.from({ length: 60 }, (_, i) => ({ pin: i, label: `button ${i}` })));
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long.endsWith("…")).toBe(true);
  });
});
