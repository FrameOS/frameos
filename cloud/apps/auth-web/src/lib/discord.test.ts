import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyDiscord } from "./discord";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.DISCORD_REPORTS_WEBHOOK_URL;
});

describe("notifyDiscord", () => {
  it("does nothing when no webhook is configured", async () => {
    await notifyDiscord("hello");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the message to the configured webhook without mentions", async () => {
    process.env.DISCORD_REPORTS_WEBHOOK_URL =
      "https://discord.example/webhook";
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await notifyDiscord("scene reported @everyone");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://discord.example/webhook");
    const body = JSON.parse(String(init?.body));
    expect(body.content).toBe("scene reported @everyone");
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("truncates long messages to Discord's limit", async () => {
    process.env.DISCORD_REPORTS_WEBHOOK_URL =
      "https://discord.example/webhook";
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await notifyDiscord("x".repeat(5000));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.content.length).toBe(1900);
  });

  it("swallows webhook failures", async () => {
    process.env.DISCORD_REPORTS_WEBHOOK_URL =
      "https://discord.example/webhook";
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    // A broken ops webhook is a warning, not an error: it does not affect the
    // user-facing flow that triggered it, and routing it to reportError would
    // page someone every time Discord hiccups. lib/log.ts writes warnings
    // through console.warn as structured JSON.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(notifyDiscord("hello")).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "discord.webhook_failed",
      level: "warn",
    });
    warnSpy.mockRestore();
  });
});
