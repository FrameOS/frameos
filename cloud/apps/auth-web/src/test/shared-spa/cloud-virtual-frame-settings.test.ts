import { describe, expect, it } from "vitest";
import {
  cloudVirtualFrameErrorMessage,
  parseVirtualDimension,
  virtualIntervalLabel,
  VIRTUAL_FRAME_MAX_DIMENSION,
  VIRTUAL_FRAME_MIN_DIMENSION,
} from "../../../../../../frontend/src/scenes/frame/panels/FrameSettings/cloudVirtualFrameLogic";
import { virtualFrameErrorMessage } from "../../../../../../cloud-frontend/src/components/VirtualFrameForm";
import { virtualFrameMaxDimension, virtualFrameMinDimension } from "../../lib/virtual-frames";

// The Settings panel's "Virtual frame" section on the cloud
// (cloudVirtualFrameLogic) and the "Add frame" form that makes one: the
// parts that are rules rather than layout.
describe("a cloud virtual frame's size fields", () => {
  it("takes whole pixels inside what the cloud accepts", () => {
    expect(parseVirtualDimension("800")).toBe(800);
    expect(parseVirtualDimension(" 1920 ")).toBe(1920);
    expect(parseVirtualDimension("16")).toBe(16);
    expect(parseVirtualDimension("4096")).toBe(4096);
    for (const bad of ["", "15", "4097", "800.5", "-800", "8e2", "wide"]) {
      expect(parseVirtualDimension(bad), bad).toBeNull();
    }
  });

  it("uses the bounds the server enforces", () => {
    expect(VIRTUAL_FRAME_MIN_DIMENSION).toBe(virtualFrameMinDimension);
    expect(VIRTUAL_FRAME_MAX_DIMENSION).toBe(virtualFrameMaxDimension);
  });
});

describe("how the section says an interval", () => {
  it("speaks in the largest whole unit", () => {
    expect(virtualIntervalLabel(300)).toBe("every 5 minutes");
    expect(virtualIntervalLabel(60)).toBe("every minute");
    expect(virtualIntervalLabel(3600)).toBe("every hour");
    expect(virtualIntervalLabel(7200)).toBe("every 2 hours");
    expect(virtualIntervalLabel(5400)).toBe("every 90 minutes");
    expect(virtualIntervalLabel(90)).toBe("every 90 seconds");
  });
});

describe("refusals, in words", () => {
  it("names what the settings route refused", () => {
    expect(cloudVirtualFrameErrorMessage("size_too_large")).toMatch(/more pixels/);
    expect(cloudVirtualFrameErrorMessage("invalid_size")).toMatch(/16 to 4096/);
    expect(cloudVirtualFrameErrorMessage("not_virtual")).toBe("This frame is not a virtual frame.");
    expect(cloudVirtualFrameErrorMessage("something_new")).toBe("Something went wrong. Try again.");
    expect(cloudVirtualFrameErrorMessage(null)).toBe("Something went wrong. Try again.");
  });

  it("names what creating one refused", () => {
    expect(virtualFrameErrorMessage("cloud_rendered_frame_quota_exceeded", 0)).toBe(
      "Virtual frames are part of the paid plans.",
    );
    expect(virtualFrameErrorMessage("cloud_rendered_frame_quota_exceeded", 1)).toMatch(/includes 1 virtual frame,/);
    expect(virtualFrameErrorMessage(undefined)).toMatch(/Could not create the frame/);
  });
});
