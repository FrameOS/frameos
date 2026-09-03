import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPostHogCapturePayload, capturePostHogEvent } from "./posthog-capture";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
});

describe("buildPostHogCapturePayload", () => {
  it("stamps the library and keeps the caller's properties", () => {
    expect(
      buildPostHogCapturePayload(
        "thing happened",
        "acc-42",
        { detail: "x" },
        "phc_test",
      ),
    ).toEqual({
      api_key: "phc_test",
      distinct_id: "acc-42",
      event: "thing happened",
      properties: { $lib: "frameos-cloud-auth-web", detail: "x" },
    });
  });
});

describe("capturePostHogEvent", () => {
  it("does nothing when PostHog is not configured", async () => {
    await capturePostHogEvent("thing happened", "acc-1", {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the configured host", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://ph.example/";
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await capturePostHogEvent("thing happened", "acc-1", { detail: "x" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://ph.example/capture/");
    expect(JSON.parse(String(init?.body))).toEqual({
      api_key: "phc_test",
      distinct_id: "acc-1",
      event: "thing happened",
      properties: { $lib: "frameos-cloud-auth-web", detail: "x" },
    });
  });

  it("defaults to the EU host", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await capturePostHogEvent("thing happened", "acc-1", {});

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://eu.i.posthog.com/capture/",
    );
  });

  it("swallows fetch failures with a warning", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    fetchMock.mockRejectedValue(new Error("network down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      capturePostHogEvent("thing happened", "acc-1", {}),
    ).resolves.toBeUndefined();

    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "posthog_capture.failed",
      level: "warn",
    });
    warnSpy.mockRestore();
  });

  it("swallows non-2xx responses with a warning", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      capturePostHogEvent("thing happened", "acc-1", {}),
    ).resolves.toBeUndefined();

    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "posthog_capture.rejected",
      status: 500,
    });
    warnSpy.mockRestore();
  });
});
