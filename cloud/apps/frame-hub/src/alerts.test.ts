import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertEvent, raiseAlert, resetAlertsForTests } from "./alerts";

const savedEnv = { ...process.env };
let sent: { event: string; properties: Record<string, unknown> }[];

beforeEach(() => {
  sent = [];
  resetAlertsForTests();
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string) as (typeof sent)[number]);
    return new Response(null, { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...savedEnv };
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("raiseAlert", () => {
  it("sends the one event the Discord workflow listens for", async () => {
    raiseAlert("hub_store_failed", "The hub could not save a picture.", { frameId: "f1" });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.event).toBe(alertEvent);
    expect(sent[0]!.properties).toMatchObject({
      frameId: "f1",
      kind: "hub_store_failed",
      source: "frame-hub",
      summary: "The hub could not save a picture.",
    });
  });

  it("holds back a repeat of the same kind, not a different kind", async () => {
    const at = 1_000_000;
    raiseAlert("a", "first", {}, at);
    raiseAlert("a", "again", {}, at + 60_000);
    raiseAlert("b", "other", {}, at + 60_000);
    await flush();
    expect(sent.map((event) => event.properties.summary)).toEqual(["first", "other"]);

    raiseAlert("a", "later", {}, at + 16 * 60_000);
    await flush();
    expect(sent.map((event) => event.properties.summary)).toEqual(["first", "other", "later"]);
  });

  it("sends nothing without a key", async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    raiseAlert("a", "first");
    await flush();
    expect(sent).toEqual([]);
  });
});
