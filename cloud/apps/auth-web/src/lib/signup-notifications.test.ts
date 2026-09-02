import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPostHogCapturePayload,
  notifyNewCloudUser,
} from "./signup-notifications";

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
  it("builds a capture payload keyed on the account id", () => {
    expect(
      buildPostHogCapturePayload(
        {
          accountId: "acc-42",
          displayName: "Ada",
          email: "ada@example.com",
          provider: "google",
        },
        "phc_test",
      ),
    ).toEqual({
      api_key: "phc_test",
      distinct_id: "acc-42",
      event: "cloud user signed up",
      properties: {
        $lib: "frameos-cloud-auth-web",
        display_name: "Ada",
        email: "ada@example.com",
        provider: "google",
      },
    });
  });
});

describe("notifyNewCloudUser", () => {
  const input = {
    accountId: "acc-1",
    displayName: "Ada",
    email: "ada@example.com",
    provider: "password",
  };

  it("does nothing when PostHog is not configured", async () => {
    await notifyNewCloudUser(input);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("captures to the configured PostHog host", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://ph.example";
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await notifyNewCloudUser(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://ph.example/capture/");
    const posthogBody = JSON.parse(String(init?.body));
    expect(posthogBody.api_key).toBe("phc_test");
    expect(posthogBody.distinct_id).toBe("acc-1");
    expect(posthogBody.event).toBe("cloud user signed up");
    expect(posthogBody.properties.$lib).toBe("frameos-cloud-auth-web");
  });

  it("defaults to the EU host when none is configured", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await notifyNewCloudUser(input);

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://eu.i.posthog.com/capture/",
    );
  });

  it("swallows fetch failures", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    fetchMock.mockRejectedValue(new Error("network down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(notifyNewCloudUser(input)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("swallows non-2xx responses with a warning", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(notifyNewCloudUser(input)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
