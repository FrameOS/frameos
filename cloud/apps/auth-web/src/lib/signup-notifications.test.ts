import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyNewCloudUser } from "./signup-notifications";

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

describe("notifyNewCloudUser", () => {
  const input = {
    accountId: "acc-1",
    analyticsConsent: "granted" as const,
    displayName: "Ada",
    email: "ada@example.com",
    provider: "password",
  };

  it("does nothing when PostHog is not configured", async () => {
    await notifyNewCloudUser(input);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("captures a signup event keyed on the account id", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://ph.example";
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await notifyNewCloudUser(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://ph.example/capture/");
    expect(JSON.parse(String(init?.body))).toEqual({
      api_key: "phc_test",
      distinct_id: "acc-1",
      event: "cloud user signed up",
      properties: {
        $lib: "frameos-cloud-auth-web",
        display_name: "Ada",
        email: "ada@example.com",
        provider: "password",
      },
    });
  });

  // The privacy page's processor list does not have PostHog seeing a
  // signup address for someone who declined analytics, or never answered.
  it.each([["denied" as const], [undefined]])(
    "leaves the email and name out when consent is %s",
    async (analyticsConsent) => {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

      await notifyNewCloudUser({ ...input, analyticsConsent });

      const [, init] = fetchMock.mock.calls[0]!;
      expect(JSON.parse(String(init?.body)).properties).toEqual({
        $lib: "frameos-cloud-auth-web",
        provider: "password",
      });
    },
  );

  it("never throws", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    fetchMock.mockRejectedValue(new Error("network down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(notifyNewCloudUser(input)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
