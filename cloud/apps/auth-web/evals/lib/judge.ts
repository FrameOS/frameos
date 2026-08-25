// Vision judge: shows the rendered frame to a model together with the user's
// request and asks for a 1-5 score. Deterministic checks catch structure;
// this catches "it rendered, but it is not a word clock". Structured output
// keeps the verdict machine-readable.
import { OPENAI_RESPONSES_URL, modelSupportsReasoning } from "../../src/lib/ai/openai";
import type { JudgeVerdict } from "./types";

export const DEFAULT_JUDGE_MODEL = "gpt-5.5";

const JUDGE_INSTRUCTIONS = `
You grade rendered FrameOS scenes: single screens shown on e-ink or LCD smart frames. You get the
user's request, optional rubric notes, the frame size, and the rendered image.

Score 1-5:
5 = does exactly what was asked, looks intentional and readable at the panel size, nothing broken.
4 = does what was asked with minor layout/typography rough edges.
3 = recognisably the requested thing but with a clear flaw (cramped, tiny text, missing one asked element,
    placeholder-looking data).
2 = mostly wrong or largely unreadable, error text visible, key element missing.
1 = blank, garbage, or unrelated.

Be strict about: text cut off or overlapping, unreadably small type for the panel size, visible error
messages, empty areas that were meant to hold content, and requests that were ignored. Reward deliberate,
modern visual design — hierarchy, whitespace, rich and smooth colour (gradients, deep or muted tones, one
accent) — and mark down both a bland grey-on-white layout with no visual idea and a garish layout of pure
saturated primaries (red/green/blue/yellow blocks side by side, like a 1990s slide). Ignore: dithering
or colour quantisation artifacts. The request may quote EXAMPLE values ("IT IS HALF PAST NINE", a city,
a price, a date): the render shows REAL live values at the render time given below, so never mark a
scene down for showing different real values — only for showing placeholders, errors, or nothing. When
the render time is given, a clock/date scene is correct if it matches that time (within a few minutes).
Return JSON only.
`.trim();

const VERDICT_SCHEMA = {
  additionalProperties: false,
  properties: {
    problems: { items: { type: "string" }, type: "array" },
    score: { maximum: 5, minimum: 1, type: "integer" },
    verdict: { type: "string" },
  },
  required: ["score", "verdict", "problems"],
  type: "object",
};

export async function judgeRender({
  apiKey,
  model = DEFAULT_JUDGE_MODEL,
  prompt,
  rubric,
  png,
  width,
  height,
  renderedAt,
  comparePng,
  signal,
}: {
  apiKey: string;
  model?: string;
  prompt: string;
  rubric?: string | undefined;
  png: Buffer;
  width: number;
  height: number;
  /** When the frame was rendered, so clocks and dates can be verified. */
  renderedAt?: Date | undefined;
  /** A "before" render: the verdict then scores the main image RELATIVE to it. */
  comparePng?: Buffer | undefined;
  signal?: AbortSignal;
}): Promise<JudgeVerdict> {
  const at = renderedAt ?? new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const text = [
    `User request: ${prompt}`,
    rubric ? `Rubric notes: ${rubric}` : null,
    `Frame size: ${width}x${height}`,
    `Rendered at: ${at.toLocaleString("en-GB", { timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })} (${timeZone})`,
    comparePng
      ? "Two images follow. Image 1 is the scene BEFORE a design pass, image 2 is AFTER. Score image 2 RELATIVE to image 1: 5 = clearly better (more depth, intent and polish, nothing lost), 4 = somewhat better, 3 = no real difference, 2 = worse in some way, 1 = clearly worse. Any new overlap, clipped or covered text, clutter, decoration crossing content, or lost information caps at 2."
      : "Grade the attached render.",
  ]
    .filter(Boolean)
    .join("\n");
  const images = comparePng ? [comparePng, png] : [png];
  const body: Record<string, unknown> = {
    input: [
      {
        content: [
          { text, type: "input_text" },
          ...images.map((image) => ({
            detail: "high",
            image_url: `data:image/png;base64,${image.toString("base64")}`,
            type: "input_image",
          })),
        ],
        role: "user",
      },
    ],
    instructions: JUDGE_INSTRUCTIONS,
    model,
    store: false,
    text: {
      format: {
        name: "scene_verdict",
        schema: VERDICT_SCHEMA,
        strict: true,
        type: "json_schema",
      },
    },
  };
  if (modelSupportsReasoning(model)) {
    body.reasoning = { effort: "low" };
  }
  const response = await fetch(OPENAI_RESPONSES_URL, {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    method: "POST",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`judge request failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const payload = (await response.json()) as { output?: unknown[]; output_text?: string };
  const outputText =
    payload.output_text ??
    (Array.isArray(payload.output)
      ? payload.output
          .flatMap((item) => {
            const content = (item as { content?: unknown[] }).content;
            return Array.isArray(content) ? content : [];
          })
          .map((part) => (part as { text?: string }).text ?? "")
          .join("")
      : "");
  const parsed = JSON.parse(outputText) as JudgeVerdict;
  return {
    problems: Array.isArray(parsed.problems) ? parsed.problems.map(String) : [],
    score: Math.max(1, Math.min(5, Number(parsed.score) || 1)),
    verdict: String(parsed.verdict ?? ""),
  };
}
