import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPostHogCapturePayload,
  formatDiscordSignupMessage,
  notifyNewCloudUser,
  sanitizeForDiscord,
} from "./signup-notifications";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.FRAMEOS_CLOUD_DISCORD_REPORTS_WEBHOOK_URL;
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
});

describe("sanitizeForDiscord", () => {
  it("strips mention triggers and collapses whitespace to one line", () => {
    expect(sanitizeForDiscord("@everyone\nhi\t@here")).toBe("everyone hi here");
  });

  it("keeps backticks", () => {
    expect(sanitizeForDiscord("`fancy` name")).toBe("`fancy` name");
  });
});

describe("formatDiscordSignupMessage", () => {
  it("prefers the display name", () => {
    expect(
      formatDiscordSignupMessage({
        accountId: "acc-1",
        displayName: "Ada Lovelace",
        email: "ada@example.com",
        provider: "google",
      }),
    ).toBe("🎉 New FrameOS Cloud user: Ada Lovelace (via google)");
  });

  it("falls back to the email, then the account id", () => {
    expect(
      formatDiscordSignupMessage({
        accountId: "acc-1",
        email: "ada@example.com",
        provider: "password",
      }),
    ).toBe("🎉 New FrameOS Cloud user: ada@example.com (via password)");
    expect(
      formatDiscordSignupMessage({ accountId: "acc-1", provider: "password" }),
    ).toBe("🎉 New FrameOS Cloud user: acc-1 (via password)");
  });

  it("neutralizes mention injection in display names", () => {
    const message = formatDiscordSignupMessage({
      accountId: "acc-1",
      displayName: "@everyone free frames\nclick here",
      email: "spam@example.com",
      provider: "password",
    });
    expect(message).toBe(
      "🎉 New FrameOS Cloud user: everyone free frames click here (via password)",
    );
    expect(message).not.toContain("@");
    expect(message).not.toContain("\n");
  });
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

  it("does nothing when neither sink is configured", async () => {
    await notifyNewCloudUser(input);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to both sinks when both are configured", async () => {
    process.env.FRAMEOS_CLOUD_DISCORD_REPORTS_WEBHOOK_URL =
      "https://discord.example/webhook";
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://ph.example";
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await notifyNewCloudUser(input);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = new Map(
      fetchMock.mock.calls.map(([url, init]) => [String(url), init]),
    );

    const discordBody = JSON.parse(
      String(calls.get("https://discord.example/webhook")?.body),
    );
    expect(discordBody.content).toBe(
      "🎉 New FrameOS Cloud user: Ada (via password)",
    );
    expect(discordBody.allowed_mentions).toEqual({ parse: [] });

    const posthogBody = JSON.parse(
      String(calls.get("https://ph.example/capture/")?.body),
    );
    expect(posthogBody.api_key).toBe("phc_test");
    expect(posthogBody.distinct_id).toBe("acc-1");
    expect(posthogBody.event).toBe("cloud user signed up");
    expect(posthogBody.properties.$lib).toBe("frameos-cloud-auth-web");
  });

  it("swallows fetch failures from both sinks", async () => {
    process.env.FRAMEOS_CLOUD_DISCORD_REPORTS_WEBHOOK_URL =
      "https://discord.example/webhook";
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    fetchMock.mockRejectedValue(new Error("network down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(notifyNewCloudUser(input)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("swallows non-2xx responses with a warning", async () => {
    process.env.FRAMEOS_CLOUD_DISCORD_REPORTS_WEBHOOK_URL =
      "https://discord.example/webhook";
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(notifyNewCloudUser(input)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
