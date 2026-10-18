// @vitest-environment jsdom
//
// A frame asleep between renders cannot send a newer image: the backend and
// the hub serve the last one they have. The image overlays say so with a
// small "Asleep" badge, so a refresh that changes nothing is not a mystery.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameImageSleepBadge, frameImageSleepTitle } from "../../../../../../frontend/src/components/FrameImage";
import { initKea } from "../../../../../../frontend/src/initKea";
import { framesModel } from "../../../../../../frontend/src/models/framesModel";
import type { FrameId, FrameType } from "../../../../../../frontend/src/types";

const now = Date.parse("2026-10-18T12:00:00Z");
const at = (offsetSeconds: number) => new Date(now + offsetSeconds * 1000).toISOString();

type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;

function esp32Frame(id: number, fields: Partial<FrameType> = {}): FrameType {
  return {
    id: id as unknown as FrameId,
    name: `Frame ${id}`,
    mode: "embedded",
    embedded: { platform: "esp32s3" },
    status: "ready",
    active_connections: 0,
    last_seen_at: at(-30),
    ...fields,
  } as unknown as FrameType;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  initKea();
  framesModel.mount();
});

afterEach(() => {
  cleanup();
  framesModel.unmount();
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
  vi.useRealTimers();
});

describe("the frame image's sleep badge", () => {
  it("names the wake while the frame sleeps", () => {
    const frame = esp32Frame(1, { next_wake_at: at(5 * 60) });
    expect(frameImageSleepTitle(frame)).toBe("Asleep · wakes in 5 min. Refreshing shows this image until it wakes.");
    framesModel.actions.addFrame(frame);
    render(<FrameImageSleepBadge frameId={frame.id} />);
    expect(screen.getByText("Asleep").getAttribute("title")).toBe(frameImageSleepTitle(frame));
  });

  it("is not shown for an awake, overdue or never-sleeping frame", () => {
    const frames = [
      esp32Frame(2, { next_wake_at: at(5 * 60), active_connections: 1 }),
      esp32Frame(3, { next_wake_at: at(-60 * 60) }),
      esp32Frame(4, { mode: "rpios", embedded: undefined }),
    ];
    for (const frame of frames) {
      expect(frameImageSleepTitle(frame)).toBeNull();
      framesModel.actions.addFrame(frame);
      render(<FrameImageSleepBadge frameId={frame.id} />);
    }
    expect(screen.queryByText("Asleep")).toBeNull();
  });
});
