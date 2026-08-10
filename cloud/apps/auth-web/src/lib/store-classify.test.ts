import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyStoreScene,
  isClassificationConfigured,
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

    expect(result).toEqual({
      category: "weather",
      // "Forecast!" is slugified, and the category slug is dropped as a tag.
      tags: ["forecast", "open-meteo", "e-ink"],
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.messages[1].content).toContain("data/openWeather");
    expect(body.messages[1].content).toContain("Hourly and daily forecasts.");
    expect(body.response_format.type).toBe("json_schema");
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

    expect(await classifyStoreScene({ name: "Masterpieces" })).toEqual({
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
