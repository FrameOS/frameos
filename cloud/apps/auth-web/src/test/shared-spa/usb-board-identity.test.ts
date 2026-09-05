// The one decision the "Connect over USB" card makes: what the board on the
// cable is, relative to the frame whose drawer is open. Pure over the
// device's `usb_api status` JSON; the card only chooses what to show from it.
import { describe, expect, it } from "vitest";
import {
  backendHostPort,
  classifyUsbBoard,
  isUsbSilenceError,
  normalizedFirmwareVersion,
} from "../../../../../../frontend/src/scenes/workspace/usbBoardIdentity";

const backendFrame = { id: 66 } as const;
const cloudFrame = { id: "0f4c2f0e-9c7a-4d2b-8a1e-2f9f6f0c1a11" } as const;

describe("classifyUsbBoard on the self-hosted backend", () => {
  it("a board that never answered is silent", () => {
    expect(classifyUsbBoard(backendFrame, null, "backend").kind).toBe("silent");
  });

  it("a FrameOS board with no frame configured is unprovisioned", () => {
    const status = { version: "2026.9.9", config: { frameId: 0, backendUrl: "" }, cloud: { frameId: "" } };
    expect(classifyUsbBoard(backendFrame, status, "backend").kind).toBe("unprovisioned");
  });

  it("a board configured as this frame on this backend is this frame", () => {
    const status = { config: { frameId: 66, backendUrl: "http://10.0.0.5:8989" } };
    expect(classifyUsbBoard(backendFrame, status, "backend", "10.0.0.5:8989").kind).toBe("this-frame");
    // Scheme and trailing slash do not matter.
    expect(classifyUsbBoard(backendFrame, status, "backend", "http://10.0.0.5:8989/").kind).toBe("this-frame");
    // Without a plan to compare against, the id is all there is.
    expect(classifyUsbBoard(backendFrame, status, "backend").kind).toBe("this-frame");
  });

  it("the same frame number on a different backend is another frame", () => {
    const status = { config: { frameId: 66, backendUrl: "http://192.168.1.20:8989" } };
    const identity = classifyUsbBoard(backendFrame, status, "backend", "http://10.0.0.5:8989");
    expect(identity.kind).toBe("other-frame");
    expect(identity.kind === "other-frame" && identity.label).toContain("192.168.1.20:8989");
  });

  it("a different frame number is another frame", () => {
    const status = { config: { frameId: 12, backendUrl: "http://10.0.0.5:8989" } };
    const identity = classifyUsbBoard(backendFrame, status, "backend", "http://10.0.0.5:8989");
    expect(identity.kind).toBe("other-frame");
    expect(identity.kind === "other-frame" && identity.label).toContain("frame #12");
  });

  it("a cloud-enrolled board is another frame from the backend's point of view", () => {
    const status = { config: { frameId: 0, backendUrl: "" }, cloud: { frameId: cloudFrame.id } };
    const identity = classifyUsbBoard(backendFrame, status, "backend");
    expect(identity.kind).toBe("other-frame");
    expect(identity.kind === "other-frame" && identity.label).toContain("cloud-managed");
  });

  it("frame ids compare as numbers, not strings with padding", () => {
    const status = { config: { frameId: 660, backendUrl: "http://10.0.0.5:8989" } };
    expect(classifyUsbBoard(backendFrame, status, "backend").kind).toBe("other-frame");
  });
});

describe("classifyUsbBoard on the cloud", () => {
  it("matches on the cloud frame id", () => {
    const status = { cloud: { frameId: cloudFrame.id }, config: { frameId: 0, backendUrl: "" } };
    expect(classifyUsbBoard(cloudFrame, status, "cloud").kind).toBe("this-frame");
  });

  it("another cloud frame id is another frame", () => {
    const status = { cloud: { frameId: "11111111-2222-3333-4444-555555555555" } };
    const identity = classifyUsbBoard(cloudFrame, status, "cloud");
    expect(identity.kind).toBe("other-frame");
    expect(identity.kind === "other-frame" && identity.label).toContain("11111111");
  });

  it("a backend-provisioned board is another frame from the cloud's point of view", () => {
    const status = { cloud: { frameId: "" }, config: { frameId: 3, backendUrl: "http://10.0.0.5:8989" } };
    const identity = classifyUsbBoard(cloudFrame, status, "cloud");
    expect(identity.kind).toBe("other-frame");
    expect(identity.kind === "other-frame" && identity.label).toContain("frame #3");
  });

  it("a wiped board is unprovisioned", () => {
    const status = { version: "2026.9.9", cloud: { frameId: "" }, config: { frameId: 0, backendUrl: "" } };
    expect(classifyUsbBoard(cloudFrame, status, "cloud").kind).toBe("unprovisioned");
  });
});

describe("helpers", () => {
  it("backendHostPort normalises the device's spelling of a backend", () => {
    expect(backendHostPort("http://10.0.0.5:8989")).toBe("10.0.0.5:8989");
    expect(backendHostPort("10.0.0.5:8989/")).toBe("10.0.0.5:8989");
    expect(backendHostPort("https://frames.example.com")).toBe("frames.example.com:443");
    expect(backendHostPort("HTTP://Frames.Example.com/api")).toBe("frames.example.com:80");
    expect(backendHostPort("")).toBe("");
    expect(backendHostPort(undefined)).toBe("");
  });

  it("normalizedFirmwareVersion strips the v prefix", () => {
    expect(normalizedFirmwareVersion("v2026.9.9")).toBe("2026.9.9");
    expect(normalizedFirmwareVersion(" 2026.9.9 ")).toBe("2026.9.9");
    expect(normalizedFirmwareVersion("")).toBeNull();
  });

  it("isUsbSilenceError recognises the probe timeout and nothing else", () => {
    expect(isUsbSilenceError(new Error("Timed out waiting for USB command response: status"))).toBe(true);
    expect(isUsbSilenceError(new Error("Timed out waiting for USB command ready: status"))).toBe(true);
    expect(isUsbSilenceError(new Error("Failed to open serial port"))).toBe(false);
  });
});
