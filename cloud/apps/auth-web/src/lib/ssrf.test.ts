import { describe, expect, it } from "vitest";
import { addressIsPrivate } from "./ssrf";

describe("addressIsPrivate", () => {
  it("blocks the RFC 1918, loopback, link-local and CGNAT v4 ranges", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(addressIsPrivate(address), address).toBe(true);
    }
  });

  it("blocks 192.0.0.0/24 and 198.18.0.0/15 but not their public neighbours", () => {
    expect(addressIsPrivate("192.0.0.1")).toBe(true);
    expect(addressIsPrivate("192.0.0.255")).toBe(true);
    expect(addressIsPrivate("192.0.1.1")).toBe(false);
    expect(addressIsPrivate("192.0.2.1")).toBe(false);
    expect(addressIsPrivate("198.18.0.1")).toBe(true);
    expect(addressIsPrivate("198.19.255.255")).toBe(true);
    expect(addressIsPrivate("198.17.255.255")).toBe(false);
    expect(addressIsPrivate("198.20.0.1")).toBe(false);
  });

  it("lets public v4 addresses through", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1"]) {
      expect(addressIsPrivate(address), address).toBe(false);
    }
  });

  it("blocks the v6 forms that embed a v4 address: mapped, NAT64, 6to4", () => {
    for (const address of [
      "::ffff:10.0.0.1",
      "::ffff:8.8.8.8",
      "::ffff:a00:1",
      "64:ff9b::10.0.0.1",
      "64:ff9b::808:808",
      "64:ff9b:0:0:0:0:a00:1",
      "2002:a00:1::",
      "2002:c0a8:101::1",
    ]) {
      expect(addressIsPrivate(address), address).toBe(true);
    }
  });

  it("blocks v6 loopback, unspecified, link-local and unique-local", () => {
    for (const address of ["::", "::1", "fe80::1", "fe80::1%eth0", "fc00::1", "fd12::1"]) {
      expect(addressIsPrivate(address), address).toBe(true);
    }
    expect(addressIsPrivate("2606:4700:4700::1111")).toBe(false);
    expect(addressIsPrivate("2001:db8::1")).toBe(false);
  });
});
