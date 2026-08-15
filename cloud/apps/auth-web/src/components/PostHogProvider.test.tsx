// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED } from "../lib/analytics-redaction";

const init = vi.fn();
vi.mock("posthog-js", () => ({ default: { init } }));

// Imported after the mock is registered.
const { PostHogProvider } = await import("./PostHogProvider");

beforeEach(() => {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
});

afterEach(() => {
  cleanup();
  init.mockReset();
  window.history.pushState({}, "", "/");
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
});

function initConfig() {
  render(<PostHogProvider>{null}</PostHogProvider>);
  expect(init).toHaveBeenCalledTimes(1);
  return init.mock.calls[0]![1] as Record<string, unknown>;
}

describe("PostHogProvider", () => {
  it("masks element attributes, so image and link URLs never leave", () => {
    // `ph-sensitive` does not cover attributes — only element text and an
    // anchor's href — so this config flag is the only thing keeping scene
    // preview images (attr__src) out of autocapture.
    expect(initConfig().mask_all_element_attributes).toBe(true);
  });

  it("hands the sensitive query parameters to posthog's own masking", () => {
    const config = initConfig();
    expect(config.mask_personal_data_properties).toBe(true);
    expect(config.custom_personal_data_properties).toContain("share");
    expect(config.custom_personal_data_properties).toContain("token");
    expect(config.custom_personal_data_properties).toContain("user_code");
  });

  // The node-environment tests in lib/analytics-redaction.test.ts cover the
  // URL-carrying events. This is the other branch: an event with no URL of
  // its own, dropped because of where the browser actually is.
  it("drops an event with no url while the browser is on /admin", () => {
    const beforeSend = initConfig().before_send as (
      data: { event: string; properties?: Record<string, unknown> } | null,
    ) => unknown;

    window.history.pushState({}, "", "/admin/scenes");
    expect(beforeSend({ event: "$identify" })).toBeNull();
    expect(beforeSend({ event: "$autocapture", properties: { x: 1 } })).toBeNull();

    window.history.pushState({}, "", "/account");
    expect(beforeSend({ event: "$identify" })).not.toBeNull();
  });

  it("redacts capability tokens through the before_send hook", () => {
    const beforeSend = initConfig().before_send as (
      data: { event: string; properties: Record<string, unknown> } | null,
    ) => { properties: Record<string, unknown> } | null;

    expect(
      beforeSend({
        event: "$pageview",
        properties: { $current_url: "https://cloud.frameos.net/recovery?token=abc" },
      })?.properties.$current_url,
    ).toBe(`https://cloud.frameos.net/recovery?token=${REDACTED}`);
  });
});
