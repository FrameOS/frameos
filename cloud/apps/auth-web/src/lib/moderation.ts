// Content moderation for the public store. Everything a
// user can push onto publicly visible pages — scene name, description, preview
// image — is classified before it is accepted, using OpenAI's free
// omni-moderation endpoint (one call covers text and image together).
//
// Configuration: set OPENAI_API_KEY to enable. Without a key, checks are
// skipped (dev/self-hosted installs), which the caller can see via
// `checked: false`. When a key IS configured, an unreachable moderation API
// fails closed — content that cannot be checked is not accepted.

const moderationEndpoint = "https://api.openai.com/v1/moderations";
const moderationModel = "omni-moderation-latest";
const moderationTimeoutMs = 20_000;

// Categories that block publication. Deliberately excludes plain "violence"
// (tripped by harmless artwork); gore is "violence/graphic". Text-only
// abuse (harassment/hate) is included to keep vulgar listings off the store.
const blockedCategories = new Set([
  "harassment",
  "harassment/threatening",
  "hate",
  "hate/threatening",
  "self-harm",
  "self-harm/instructions",
  "self-harm/intent",
  "sexual",
  "sexual/minors",
  "violence/graphic",
]);

export type ModerationResult =
  | { ok: true; checked: boolean }
  | { ok: false; error: "content_rejected"; categories: string[] }
  | { ok: false; error: "moderation_unavailable" };

export function isModerationConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export async function moderateStoreContent(input: {
  texts: (string | null | undefined)[];
  image?: { content: Buffer; contentType: string };
}): Promise<ModerationResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { ok: true, checked: false };
  }

  const parts: Record<string, unknown>[] = input.texts
    .map((text) => text?.trim())
    .filter((text): text is string => Boolean(text))
    .map((text) => ({ text: text.slice(0, 10_000), type: "text" }));
  if (input.image) {
    parts.push({
      image_url: {
        url: `data:${input.image.contentType};base64,${input.image.content.toString("base64")}`,
      },
      type: "image_url",
    });
  }
  if (parts.length === 0) {
    return { ok: true, checked: true };
  }

  // One retry: moderation gates publishing, so a transient blip should not
  // bounce a legitimate publish, but a hard outage must fail closed.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(moderationEndpoint, {
        body: JSON.stringify({ input: parts, model: moderationModel }),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(moderationTimeoutMs),
      });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as {
        results?: { categories?: Record<string, boolean> }[];
      };
      const results = payload.results;
      if (!Array.isArray(results) || results.length === 0) {
        continue;
      }
      const flagged = new Set<string>();
      for (const result of results) {
        for (const [category, value] of Object.entries(
          result.categories ?? {},
        )) {
          if (value && blockedCategories.has(category)) {
            flagged.add(category);
          }
        }
      }
      if (flagged.size > 0) {
        return {
          ok: false,
          error: "content_rejected",
          categories: [...flagged].sort(),
        };
      }
      return { ok: true, checked: true };
    } catch {
      // fall through to retry / unavailable
    }
  }

  return { ok: false, error: "moderation_unavailable" };
}
