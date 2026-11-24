import { describe, expect, it } from "vitest";
import { InboundGuard, deviceInboundLimits, inboundBytes } from "./inbound-guard";

const limits = { backlogBytes: 1000, backlogMessages: 4, burst: 5, perSecond: 2 };

describe("InboundGuard", () => {
  it("lets a burst through, then the sustained rate, then refuses", () => {
    let now = 0;
    const guard = new InboundGuard(limits, () => now);
    for (let i = 0; i < 5; i += 1) {
      expect(guard.admit(1)).toBeUndefined();
      guard.handled(1);
    }
    expect(guard.admit(1)).toBe("message_rate");
    // Half a second buys one more at two a second.
    now += 500;
    expect(guard.admit(1)).toBeUndefined();
    guard.handled(1);
    expect(guard.admit(1)).toBe("message_rate");
    // A long quiet spell never buys more than the burst.
    now += 60_000;
    for (let i = 0; i < 5; i += 1) {
      expect(guard.admit(1)).toBeUndefined();
      guard.handled(1);
    }
    expect(guard.admit(1)).toBe("message_rate");
  });

  it("refuses once too many messages wait to be handled", () => {
    const guard = new InboundGuard({ ...limits, burst: 100 }, () => 0);
    for (let i = 0; i < 4; i += 1) {
      expect(guard.admit(10)).toBeUndefined();
    }
    expect(guard.backlog).toEqual({ bytes: 40, messages: 4 });
    expect(guard.admit(10)).toBe("message_backlog");
    // Handling one makes room for one.
    guard.handled(10);
    expect(guard.admit(10)).toBeUndefined();
  });

  it("refuses once too many bytes wait to be handled", () => {
    const guard = new InboundGuard({ ...limits, burst: 100 }, () => 0);
    expect(guard.admit(600)).toBeUndefined();
    expect(guard.admit(600)).toBe("message_backlog");
    guard.handled(600);
    expect(guard.admit(600)).toBeUndefined();
  });

  it("clears the fastest thing a working frame does", () => {
    // Two of the largest files the hub assembles (8 MiB), streamed back in
    // the ESP32's 24 KiB chunks at a hundred a second, none of it handled
    // yet (the file before is still being stored).
    let now = 0;
    const esp32 = new InboundGuard(deviceInboundLimits, () => now);
    const esp32Chunk = Math.ceil((24 * 1024 * 4) / 3) + 120;
    const esp32Chunks = 2 * Math.ceil((8 * 1024 * 1024) / (24 * 1024));
    for (let i = 0; i < esp32Chunks; i += 1) {
      now += 10;
      expect(esp32.admit(esp32Chunk)).toBeUndefined();
    }
    expect(esp32.backlog.messages).toBe(esp32Chunks);

    // The same from a Pi, in 1 MiB chunks, all inside one second.
    const pi = new InboundGuard(deviceInboundLimits, () => now);
    const piChunk = Math.ceil((1024 * 1024 * 4) / 3) + 120;
    for (let i = 0; i < 16; i += 1) {
      now += 30;
      expect(pi.admit(piChunk)).toBeUndefined();
    }
  });

  it("measures a message the way ws hands it over", () => {
    expect(inboundBytes(Buffer.from("abc"))).toBe(3);
    expect(inboundBytes([Buffer.from("ab"), Buffer.from("cde")])).toBe(5);
    expect(inboundBytes(new ArrayBuffer(7))).toBe(7);
    expect(inboundBytes("héllo")).toBe(6);
    expect(inboundBytes(undefined)).toBe(0);
  });
});
