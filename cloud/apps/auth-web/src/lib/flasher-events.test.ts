import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const capturePostHogEvent = vi.fn(async () => undefined);
const rateLimitResponse = vi.fn(async () => undefined);
vi.mock("./posthog-capture", () => ({ capturePostHogEvent }));
vi.mock("./rate-limit", () => ({ rateLimitResponse }));

const { parseFlasherEvent } = await import("./flasher-events");
const { POST } = await import("../../app/api/flasher/events/route");

const visit = "0b6f3c1e-9a2d-4c7e-8f10-2b3c4d5e6f70";

function post(body: unknown): NextRequest {
  return new NextRequest("https://flash.frameos.net/api/flasher/events", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("the flasher's counts", () => {
  beforeEach(() => {
    capturePostHogEvent.mockClear();
  });

  it("keeps the facts it knows and drops everything else", () => {
    expect(
      parseFlasherEvent({
        event: "flasher flash finished",
        visit,
        properties: {
          kind: "setup",
          mode: "standalone",
          outcome: "done",
          board: "reterminal-e1001",
          platform: "esp32-s3",
          flash_size: "32MB",
          seconds: 83.4,
          scenes: 5,
          // Not on any list: a frame's name, a network, a URL.
          name: "Kitchen frame",
          ssid: "home",
          backend: "http://192.168.1.10:8989",
        },
      }),
    ).toEqual({
      event: "flasher flash finished",
      visit,
      properties: {
        kind: "setup",
        mode: "standalone",
        outcome: "done",
        board: "reterminal-e1001",
        platform: "esp32-s3",
        flash_size: "32MB",
        seconds: 83,
        scenes: 5,
      },
    });
  });

  it("refuses what the page does not send", () => {
    expect(parseFlasherEvent({ event: "flasher hacked", visit })).toBeNull();
    expect(parseFlasherEvent({ event: "flasher opened", visit: "me@example.com" })).toBeNull();
    expect(parseFlasherEvent(null)).toBeNull();
    // A value that is not one of its kind is left out, not the event.
    expect(
      parseFlasherEvent({
        event: "flasher opened",
        visit,
        properties: { mode: "root", board: "a b/c", scenes: -1, seconds: Infinity, board_from_link: "yes" },
      })?.properties,
    ).toEqual({});
  });

  it("passes an event on to PostHog with no person and no place", async () => {
    const response = await POST(post({ event: "flasher opened", visit, properties: { entry: "page", usb: "yes" } }));
    expect(response.status).toBe(204);
    expect(capturePostHogEvent).toHaveBeenCalledWith("flasher opened", visit, {
      entry: "page",
      usb: "yes",
      $geoip_disable: true,
      $process_person_profile: false,
      surface: "flasher",
    });
  });

  it("answers 400 to anything else and captures nothing", async () => {
    const response = await POST(post({ event: "flasher opened", visit: "nope" }));
    expect(response.status).toBe(400);
    expect(capturePostHogEvent).not.toHaveBeenCalled();
  });
});
