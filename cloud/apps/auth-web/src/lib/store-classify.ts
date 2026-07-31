import { storeCategories } from "./categories";
import { sanitizeTagCandidates } from "./store";

// Automatic categorization of published scenes: one taxonomy category plus a
// few browse tags, picked by an LLM from the scene's listing text and the app
// keywords in its node graph. Reuses the OPENAI_API_KEY that already powers
// moderation (moderation.ts). Unlike moderation this never gates anything —
// no key, a timeout, or garbage output all just mean "no suggestion"
// (undefined), and the scene publishes uncategorized.

const classifyEndpoint = "https://api.openai.com/v1/chat/completions";
const classifyTimeoutMs = 20_000;

function classifyModel() {
  return process.env.OPENAI_CLASSIFY_MODEL?.trim() || "gpt-4o-mini";
}

export type SceneClassification = {
  category: string;
  tags: string[];
};

export function isClassificationConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

const systemPrompt = [
  "You label scenes for the FrameOS scene store. Scenes run on smart picture",
  "frames — e-ink and LCD displays that show one full-screen view, refreshed",
  "on a schedule.",
  "",
  "Pick exactly one category slug that best describes what the scene shows:",
  ...storeCategories.map(
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
              enum: storeCategories.map((category) => category.slug),
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
        storeCategories.some((entry) => entry.slug === parsed.category)
          ? parsed.category
          : undefined;
      if (!category) {
        continue;
      }
      return {
        category,
        tags: sanitizeTagCandidates(parsed.tags).filter(
          (tag) => tag !== category,
        ),
      };
    } catch {
      // fall through to retry / undefined
    }
  }

  return undefined;
}
