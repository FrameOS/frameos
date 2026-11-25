import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyStoreScene,
  isClassificationConfigured,
  ruleCategory,
  ruleTags,
} from "./store-classify";
import { extractAppKeywords, sanitizeTagCandidates } from "./store";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
});

function completion(content: unknown) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
    { status: 200 },
  );
}

describe("classifyStoreScene", () => {
  it("returns undefined without an API key and reports unconfigured", async () => {
    expect(isClassificationConfigured()).toBe(false);
    expect(await classifyStoreScene({ name: "Weather" })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends listing text and app keywords, returns category and clean tags", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    fetchMock.mockResolvedValueOnce(
      completion({
        category: "weather",
        tags: ["Forecast!", "open-meteo", "weather", "e-ink"],
      }),
    );

    const result = await classifyStoreScene({
      appKeywords: ["data/openWeather", "render/text"],
      description: "Hourly and daily forecasts.",
      name: "Weather",
    });

    expect(result).toMatchObject({
      category: "weather",
      // "Forecast!" is slugified, and the category slug is dropped as a tag.
      tags: ["forecast", "open-meteo", "e-ink"],
    });
    // The counts the caller meters the call with; this stub reports none.
    expect(result?.usage).toEqual({
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.messages[1].content).toContain("data/openWeather");
    expect(body.messages[1].content).toContain("Hourly and daily forecasts.");
    expect(body.response_format.type).toBe("json_schema");
    // System is the frame's own apps, filed there only when a scene says so.
    const offered = body.response_format.json_schema.schema.properties.category.enum;
    expect(offered).toContain("weather");
    expect(offered).not.toContain("system");
    expect(body.messages[0].content).not.toContain("- system:");
  });

  it("retries once, then gives up quietly on garbage or errors", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    fetchMock.mockResolvedValueOnce(
      completion({ category: "not-a-category", tags: [] }),
    );

    expect(await classifyStoreScene({ name: "Mystery" })).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers on the retry", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    fetchMock.mockResolvedValueOnce(
      completion({ category: "art", tags: ["paintings"] }),
    );

    expect(await classifyStoreScene({ name: "Masterpieces" })).toMatchObject({
      category: "art",
      tags: ["paintings"],
    });
  });
});

describe("sanitizeTagCandidates", () => {
  it("slugifies, dedupes, and caps machine-suggested tags", () => {
    expect(
      sanitizeTagCandidates([
        "Google Photos",
        "google-photos",
        "  AI  ",
        42,
        "---",
        "a".repeat(40),
        "one",
        "two",
        "three",
      ]),
    ).toEqual(["google-photos", "ai", "a".repeat(24), "one", "two"]);
    expect(sanitizeTagCandidates("not an array")).toEqual([]);
  });
});

describe("extractAppKeywords", () => {
  it("collects unique node app keywords across scenes", () => {
    expect(
      extractAppKeywords([
        {
          nodes: [
            { data: { keyword: "data/openWeather" } },
            { data: { keyword: "render/text" } },
            { data: { keyword: "data/openWeather" } },
            { data: {} },
            {},
          ],
        },
        { nodes: [{ data: { keyword: "render/split" } }] },
        { notNodes: true },
      ]),
    ).toEqual(["data/openWeather", "render/split", "render/text"]);
    expect(extractAppKeywords("junk")).toEqual([]);
  });
});

describe("ruleCategory", () => {
  it("files what the node graph and the name say for sure, and leaves the rest to the model", () => {
    expect(ruleCategory({ appKeywords: ["openaiImage"], name: "Dream" })).toBe("ai");
    expect(ruleCategory({ name: "Sudoku" })).toBe("games");
    expect(ruleCategory({ name: "Word clock" })).toBe("clocks");
    expect(ruleCategory({ appKeywords: ["icalJson"], name: "Week" })).toBe("calendar");
    expect(ruleCategory({ appKeywords: ["immich"], name: "Family" })).toBe("photos");
    expect(ruleCategory({ description: "A week of made-up weather.", name: "Weather demo" })).toBe("demos");
    expect(ruleCategory({ appKeywords: ["jsxUi"], name: "Something" })).toBeUndefined();
  });
});

describe("ruleTags", () => {
  it("names what it needs, the services it uses and its category, never nothing", () => {
    expect(ruleTags({ category: "games", name: "Snake", needs: ["fast", "keys", "buttons"] })).toEqual([
      "lcd",
      "keyboard",
      "buttons",
      "games",
    ]);
    expect(ruleTags({ appKeywords: ["immich"], name: "Family", needs: [] })).toEqual(["e-ink", "immich"]);
    expect(ruleTags({ name: "Shell", needs: ["linux"] })).toEqual(["raspberry-pi"]);
    expect(ruleTags({ name: "x", needs: ["touch"] }).length).toBeGreaterThan(0);
  });
});
