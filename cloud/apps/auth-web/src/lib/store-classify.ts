import { sceneCategories } from "./categories";
import { sanitizeTagCandidates } from "./store";

// Automatic categorization of published scenes: one taxonomy category plus a
// few browse tags. Rules first (ruleCategory / ruleTags below: what the node
// graph and the name say for sure, free and the same every time), then an
// LLM for what the rules cannot tell, from the scene's listing text and the
// app keywords in its node graph. A layout never gets here: its shelf is its
// kind (categories.ts). Reuses the OPENAI_API_KEY that already powers
// moderation (moderation.ts). Unlike moderation this never gates anything —
// no key, a timeout, or garbage output all just mean "no suggestion"
// (undefined), and the scene publishes uncategorized.

const classifyEndpoint = "https://api.openai.com/v1/chat/completions";
const classifyTimeoutMs = 20_000;

// gpt-6-luna: the cheapest current model (OpenAI is retiring the gpt-4
// family, gpt-4o-mini with it); a category and a few tags need no more.
function classifyModel() {
  return process.env.OPENAI_CLASSIFY_MODEL?.trim() || "gpt-6-luna";
}

export type SceneClassification = {
  category: string;
  tags: string[];
  // What the call burned, so the caller can meter it. The classifier runs on
  // the operator's key, so this is our cost and nobody's charge — but an
  // unmetered model call is spend nothing in the books can explain.
  usage: ClassificationUsage;
  model: string;
};

export type ClassificationUsage = {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

// The chat-completions shape, which is not the Responses one the chat uses:
// prompt_tokens / completion_tokens, with the cached part in
// prompt_tokens_details.
function usageFrom(raw: unknown): ClassificationUsage {
  const usage = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  return {
    cachedInputTokens: num(details?.cached_tokens),
    inputTokens: num(usage.prompt_tokens),
    outputTokens: num(usage.completion_tokens),
    reasoningTokens: 0,
  };
}

export function isClassificationConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

// What the model may pick: every scene shelf but those a scene has to name
// itself (System: the frame's own apps).
const classifiable = sceneCategories.filter((category) => !category.statedOnly);

const systemPrompt = [
  "You label scenes for the FrameOS scene store. Scenes run on smart picture",
  "frames — e-ink and LCD displays that show one full-screen view, refreshed",
  "on a schedule.",
  "",
  "Pick exactly one category slug that best describes what the scene shows:",
  ...classifiable.map(
    (category) => `- ${category.slug}: ${category.hint}`,
  ),
  "",
  "Also pick 2-5 short tags for browsing: lowercase slugs (letters, digits,",
  "dashes, max 24 chars) naming the scene's topic and the services or",
  'hardware it uses, e.g. "weather", "google-photos", "openai", "e-ink".',
  "Do not repeat the category slug as a tag. Prefer specific over generic.",
].join("\n");

// Classifies one scene. `appKeywords` are the node-graph app identifiers from
// extractAppKeywords — the most honest signal about what the scene does.
export async function classifyStoreScene(input: {
  name: string;
  description?: string | null | undefined;
  appKeywords?: string[] | undefined;
  existingTags?: string[] | undefined;
}): Promise<SceneClassification | undefined> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }

  const lines = [
    `Scene name: ${input.name.slice(0, 200)}`,
    `Description: ${input.description?.trim().slice(0, 1000) || "(none)"}`,
    `Apps used in the node graph: ${
      input.appKeywords?.length ? input.appKeywords.join(", ") : "(unknown)"
    }`,
  ];
  if (input.existingTags?.length) {
    lines.push(`Current tags: ${input.existingTags.join(", ")}`);
  }

  const body = JSON.stringify({
    messages: [
      { content: systemPrompt, role: "system" },
      { content: lines.join("\n"), role: "user" },
    ],
    model: classifyModel(),
    response_format: {
      json_schema: {
        name: "scene_classification",
        schema: {
          additionalProperties: false,
          properties: {
            category: {
              enum: classifiable.map((category) => category.slug),
              type: "string",
            },
            tags: {
              items: { type: "string" },
              maxItems: 5,
              type: "array",
            },
          },
          required: ["category", "tags"],
          type: "object",
        },
        strict: true,
      },
      type: "json_schema",
    },
  });

  // One retry, then give up quietly: categorization is a nicety and must
  // never block or slow-fail a publish beyond its two timeouts.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(classifyEndpoint, {
        body,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(classifyTimeoutMs),
      });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: unknown;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        continue;
      }
      const parsed = JSON.parse(content) as {
        category?: unknown;
        tags?: unknown;
      };
      const category =
        typeof parsed.category === "string" &&
        classifiable.some((entry) => entry.slug === parsed.category)
          ? parsed.category
          : undefined;
      if (!category) {
        continue;
      }
      return {
        category,
        model: classifyModel(),
        tags: sanitizeTagCandidates(parsed.tags).filter(
          (tag) => tag !== category,
        ),
        usage: usageFrom(payload.usage),
      };
    } catch {
      // fall through to retry / undefined
    }
  }

  return undefined;
}

// What the rules read: the scene's name and description, the app keywords in
// its node graph (extractAppKeywords) and what it needs of a frame
// (sceneNeeds.ts).
export type SceneFacts = {
  name: string;
  description?: string | null | undefined;
  appKeywords?: readonly string[] | undefined;
  needs?: readonly string[] | undefined;
};

const gameWords =
  /\b(game|games|puzzle|solitaire|sudoku|chess|checkers|draughts|reversi|othello|gomoku|minesweeper|mahjong|blackjack|poker|tetris|snake|breakout|pong|2048|connect four|crossword|wordle|word guess|arcade|shoot-?em-?up|racer|lander)\b/i;
const clockWords = /\b(clock|clocks|time|timer|pomodoro|countdown|stopwatch|year progress|memento mori)\b/i;
const demoWords = /\b(demo|made-up|made up|test pattern|test chart|calibration|sample data|example)\b/i;

// A scene named for departures or a transit feed is a station board.
const transitWords = /\b(departures?|transit|gtfs)\b/i;

function keywordMatches(keywords: readonly string[], pattern: RegExp): boolean {
  return keywords.some((keyword) => pattern.test(keyword));
}

/**
 * The category the rules are sure of, or undefined to ask the model. Kept
 * narrow on purpose: a wrong rule files every scene like it wrongly, where
 * the model is wrong one scene at a time.
 */
export function ruleCategory(facts: SceneFacts): string | undefined {
  const keywords = (facts.appKeywords ?? []).map((keyword) => keyword.toLowerCase());
  const name = facts.name.trim();
  const text = `${name} ${facts.description ?? ""}`;
  if (keywordMatches(keywords, /openai|anthropic|gemini|\bllm\b|dall-?e/)) {
    return "ai";
  }
  if (demoWords.test(text)) {
    return "demos";
  }
  if (gameWords.test(name)) {
    return "games";
  }
  if (keywordMatches(keywords, /googlephotos|immich|unsplash|localimage|photoalbum|wikimedia/)) {
    // A photo service's videos are video, not photos.
    return facts.needs?.includes("video") ? "video" : "photos";
  }
  if (keywordMatches(keywords, /ical|calendar|agenda/)) {
    return "calendar";
  }
  if (keywordMatches(keywords, /weather|openmeteo|open-meteo/) && /weather|forecast/i.test(text)) {
    return "weather";
  }
  if (clockWords.test(name)) {
    return "clocks";
  }
  if (transitWords.test(name)) {
    return "transit";
  }
  return undefined;
}

// Services and hardware an app keyword names, as a browse tag.
const keywordTags: [RegExp, string][] = [
  [/openai/, "openai"],
  [/immich/, "immich"],
  [/unsplash/, "unsplash"],
  [/googlephotos/, "google-photos"],
  [/homeassistant|haremote/, "home-assistant"],
  [/homey/, "homey"],
  [/ical/, "ical"],
  [/weather|openmeteo/, "weather"],
  [/chromium/, "chromium"],
  [/rstp|rtsp/, "rtsp"],
  [/map|osm/, "map"],
  [/chart/, "charts"],
  [/localimage/, "sd-card"],
];

/**
 * Tags from what the scene is and does, for a scene published without any:
 * the store never lists a scene its search can only find by name. What it
 * needs comes first (touchscreen, lcd, keyboard), then the services its apps
 * use, then its category; at most five, never none.
 */
export function ruleTags(facts: SceneFacts & { category?: string | null | undefined }): string[] {
  const needs = facts.needs ?? [];
  const keywords = (facts.appKeywords ?? []).map((keyword) => keyword.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const tags: string[] = [];
  if (needs.includes("touch")) {
    tags.push("touchscreen");
  }
  if (needs.includes("fast")) {
    tags.push("lcd");
  } else if (!needs.includes("linux") && !needs.includes("video")) {
    tags.push("e-ink");
  }
  if (needs.includes("keys")) {
    tags.push("keyboard");
  }
  if (needs.includes("buttons")) {
    tags.push("buttons");
  }
  if (needs.includes("accelerometer")) {
    tags.push("accelerometer");
  }
  if (needs.includes("video")) {
    tags.push("video");
  }
  if (needs.includes("linux") || needs.includes("video")) {
    tags.push("raspberry-pi");
  }
  for (const [pattern, tag] of keywordTags) {
    if (keywords.some((keyword) => pattern.test(keyword))) {
      tags.push(tag);
    }
  }
  if (facts.category) {
    tags.push(facts.category);
  }
  const sanitized = sanitizeTagCandidates(tags);
  return sanitized.length > 0 ? sanitized : ["scene"];
}
