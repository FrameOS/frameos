// The Adopt frame pane's pure pieces (frontend/src/scenes/frames/adoptFrame.ts):
// what the frame page's QR code says, pasted into the address
// (docs/scene-settings.md "Connecting the frame"), and the code as it is typed.
import { describe, expect, it } from "vitest";
import {
  adoptCodeInput,
  adoptPaste,
} from "../../../../../../frontend/src/scenes/frames/adoptFrame";

describe("adoptPaste", () => {
  it("reads the address, the port and the code of a frame page's QR code", () => {
    expect(adoptPaste("192.168.1.20:8787 123456")).toEqual({
      host: "192.168.1.20",
      port: "8787",
      code: "123456",
    });
    // An ESP32 on port 80 says its address alone.
    expect(adoptPaste("10.0.0.42 654321")).toEqual({ host: "10.0.0.42", port: "", code: "654321" });
    // As people copy it: spaces around, the code in two halves.
    expect(adoptPaste("  frame.local:8787   123 456 ")).toEqual({
      host: "frame.local",
      port: "8787",
      code: "123456",
    });
  });

  it("leaves anything else to be an address as typed", () => {
    expect(adoptPaste("192.168.1.20")).toBeNull();
    expect(adoptPaste("192.168.1.20:8787")).toBeNull();
    expect(adoptPaste("http://192.168.1.20 123456")).toBeNull();
    expect(adoptPaste("192.168.1.20 12345")).toBeNull();
  });

  it("keeps digits of a typed code, six at most", () => {
    expect(adoptCodeInput("12a3-45 678")).toBe("123456");
  });
});
