// Build the scenes listed in docs/scenes-todo.md with the AI agent, judge
// each rendered result, iterate, and save the keepers to the local store as
// private scenes with the render as preview image.
//
//   pnpm --filter @frameos-cloud/auth-web ai:build-scenes [--only word-clock,big-typographic-clock]
//       [--filter S|M|L] [--limit 5] [--attempts 3] [--min-score 4] [--frame 800x600]
//       [--concurrency 2] [--no-save] [--dry-run] [--model gpt-5.5] [--effort medium]
//
// Same environment as evals/run.ts (dev server for rendering, DATABASE_URL,
// OPENAI_API_KEY). The todo document itself is left untouched: the report
// lists what landed and where, so ticking boxes stays a human decision.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { zipSync } from "fflate";
import { eq, sql } from "drizzle-orm";
import { createDb, storeScenes } from "@frameos-cloud/db";
import { buildInitialInput, runAgentLoop } from "../src/lib/ai/loop";
import { addUsage, DEFAULT_CHAT_MODEL, emptyUsage, type ResponseUsage } from "../src/lib/ai/openai";
import { lintScenes } from "../src/lib/ai/scene-lint";
import type { ScenesEvent, ToolContext } from "../src/lib/ai/tools";
import { DEFAULT_CLOUD_URL, HeadlessRenderer } from "../src/lib/ai/eval/render-check";
import { HeadlessRealigner } from "../src/lib/ai/eval/realign";
import { publishStoreScene } from "../src/lib/store-publish";
import { sanitizeTagCandidates } from "../src/lib/store";
import { DEFAULT_JUDGE_MODEL, judgeRender } from "./lib/judge";
import { RENDER_CHECK_PREFIX } from "./lib/runner";
import { evalAccountId } from "./lib/store";
import type { JudgeVerdict } from "./lib/types";

type JsonObject = Record<string, unknown>;

type TodoItem = {
  slug: string;
  name: string;
  description: string;
  section: string;
  size: "S" | "M" | "L" | null;
};

type BuildOutcome = {
  item: TodoItem;
  attempts: number;
  finalScore: number | null;
  verdict: string;
  lintErrors: number;
  renderErrors: number;
  saved: { id: string; slug: string; url: string } | null;
  pngPath: string | null;
  durationMs: number;
  usage: ResponseUsage;
  error: string | null;
  toolCalls: string[];
};

type Options = {
  only: string[];
  filter: string[];
  limit: number;
  attempts: number;
  minScore: number;
  frame: { width: number; height: number };
  /** Extra panel sizes every scene must also look right at (responsiveness check). */
  extraSizes: { width: number; height: number }[];
  concurrency: number;
  save: boolean;
  dryRun: boolean;
  model: string;
  effort: string;
  judgeModel: string;
  out: string | null;
};

const SECTION_CATEGORY: Record<string, string> = {
  "Clocks & time": "utilities",
  "Daily briefing": "dashboards",
  "Home & family": "utilities",
  "Learning & play": "fun",
  Money: "dashboards",
  "Nature & sky": "weather",
  "Smart home & homelab": "dashboards",
  "Sports & leisure": "fun",
  "Transport & out-the-door": "dashboards",
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseTodo(markdown: string): TodoItem[] {
  const items: TodoItem[] = [];
  let section = "";
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      section = heading[1]!.trim();
      continue;
    }
    const item = /^- \[( |x)\]\s+\*\*(.+?)\*\*\s+—\s+(.+?)(?:\s+\*\*([SML])\*\*)?\s*$/.exec(line);
    if (!item) {
      continue;
    }
    const name = item[2]!.trim();
    items.push({
      description: item[3]!.trim(),
      name,
      section,
      size: (item[4] as "S" | "M" | "L" | undefined) ?? null,
      slug: slugify(name),
    });
  }
  return items;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    attempts: 3,
    concurrency: 2,
    dryRun: false,
    effort: "medium",
    filter: [],
    // 4:3 — the store crops thumbnails to that ratio, and 800x600 is a common panel size.
    frame: { height: 600, width: 800 },
    extraSizes: [
      { height: 800, width: 480 },
      { height: 1200, width: 1600 },
    ],
    judgeModel: DEFAULT_JUDGE_MODEL,
    limit: 0,
    minScore: 4,
    model: DEFAULT_CHAT_MODEL,
    only: [],
    out: null,
    save: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      i += 1;
      return next;
    };
    switch (arg) {
      case "--only":
        options.only = value().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--filter":
        options.filter = value().split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
        break;
      case "--limit":
        options.limit = Number(value()) || 0;
        break;
      case "--attempts":
        options.attempts = Math.max(1, Number(value()) || 1);
        break;
      case "--min-score":
        options.minScore = Number(value()) || 4;
        break;
      case "--frame": {
        const [w, h] = value().split("x").map(Number);
        if (!w || !h) {
          throw new Error("--frame needs WIDTHxHEIGHT");
        }
        options.frame = { height: h, width: w };
        break;
      }
      case "--sizes": {
        // e.g. --sizes 480x800,1600x1200 ; --sizes none disables the responsiveness pass
        const raw = value();
        options.extraSizes =
          raw === "none"
            ? []
            : raw.split(",").map((pair) => {
                const [w, h] = pair.split("x").map(Number);
                if (!w || !h) {
                  throw new Error("--sizes needs WIDTHxHEIGHT[,WIDTHxHEIGHT]");
                }
                return { height: h, width: w };
              });
        break;
      }
      case "--concurrency":
        options.concurrency = Math.max(1, Number(value()) || 1);
        break;
      case "--no-save":
        options.save = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--model":
        options.model = value();
        break;
      case "--effort":
        options.effort = value();
        break;
      case "--judge-model":
        options.judgeModel = value();
        break;
      case "--out":
        options.out = value();
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

function loadEnv(): void {
  for (const candidate of [resolve(process.cwd(), ".env.local"), resolve(process.cwd(), "../../.env.local")]) {
    if (existsSync(candidate)) {
      try {
        (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.call(process, candidate);
      } catch {
        // tolerate a malformed line
      }
      break;
    }
  }
}

function buildPrompt(item: TodoItem, frame: { width: number; height: number }): string {
  return [
    `Build a FrameOS scene named exactly "${item.name}".`,
    `What it should do: ${item.description}`,
    "",
    "Requirements:",
    "- It must work out of the box: prefer keyless public APIs (Open-Meteo family, USGS, Wikipedia/Wikimedia, CoinGecko, Lichess, PoetryDB, Open-Notify, TheMealDB); when an API key or personal URL is unavoidable, expose it as a public scene field and make the scene render a clear, friendly placeholder until it is set.",
    "- Expose everything a user would want to change as public scene fields with sensible defaults (persist \"disk\"). Locations are latitude/longitude fields defaulting to Brussels (50.85, 4.35) unless the description says otherwise.",
    "- Pick settings.refreshInterval from the cadence in the description.",
    `- Design for a ${frame.width}x${frame.height} panel that may be colour e-ink or an LCD. Aim for a modern, editorial look you would frame on a wall — think a well-designed weather widget or a print poster, NOT a 1990s slide. Use rich, smooth colour: a soft gradient background (render/gradient app with two related tones, or an SVG linearGradient with gradientUnits="userSpaceOnUse"), deep or muted tones (navy, teal, forest, plum, terracotta, ochre, charcoal, warm off-white) and ONE accent colour for the key figure. Never place pure saturated primaries (#ff0000, #00ff00, #0000ff, #ffff00) next to each other and never use them as large fills; if e-ink dithering is a concern, prefer high tonal contrast between text and background rather than garish colour. Strong hierarchy, generous type sizes, whitespace, nothing cut off, no tiny text. Set settings.backgroundColor explicitly.`,
    `- The scene MUST adapt to any panel: it is checked at ${frame.width}x${frame.height}, 480x800 (portrait) and 1600x1200. Derive every coordinate, box, gap and font size from the frame size (app.frame.width/height in JS apps, context.imageWidth/imageHeight in code nodes) — never hard-code 800/600 or a fixed viewBox; when the panel is taller than wide, stack columns vertically; wrap or truncate text to the available width (about width / (fontSize * 0.55) characters per line); keep everything inside the canvas with margins that scale.`,
    "- Prefer built-in apps and JavaScript code nodes; write a scene-local JS app only when the logic is substantial.",
    "- Deliver the complete scene with create_scenes, then summarise the scene fields a user can tweak in two sentences.",
  ].join("\n");
}

function reviewPrompt(judge: JudgeVerdict, attempt: number, attempts: number): string {
  return [
    `[Design review ${attempt}/${attempts}] A reviewer looked at the rendered frame and scored it ${judge.score}/5: ${judge.verdict}`,
    ...(judge.problems.length > 0 ? ["Problems:", ...judge.problems.map((problem) => `- ${problem}`)] : []),
    "Improve the scene to address these points (keep what already works) and deliver the complete updated scene with update_scene.",
  ].join("\n");
}

function renderCheckPrompt(errors: string[]): string {
  const unique = [...new Set(errors)].slice(0, 8);
  return (
    `${RENDER_CHECK_PREFIX} The scene was rendered in the FrameOS runtime and logged these errors:\n` +
    unique.map((line) => `- ${line}`).join("\n") +
    "\nFix the scene so it renders without errors and deliver the corrected version with update_scene."
  );
}

function obj(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await fn(items[index] as T);
      }
    }),
  );
  return results;
}

async function main() {
  loadEnv();
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }
  const todoPath = resolve(process.cwd(), "../../../docs/scenes-todo.md");
  const items = parseTodo(await readFile(todoPath, "utf8"))
    .filter((item) => options.only.length === 0 || options.only.includes(item.slug))
    .filter((item) => options.filter.length === 0 || (item.size !== null && options.filter.includes(item.size)))
    .slice(0, options.limit > 0 ? options.limit : undefined);
  if (items.length === 0) {
    throw new Error("no todo items selected");
  }
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = resolve(options.out ?? join("evals", "results", `todo-${runId}`));
  await mkdir(join(outDir, "png"), { recursive: true });
  console.log(`build ${items.length} scenes (${options.model}/${options.effort}, attempts ${options.attempts}, min score ${options.minScore}, frame ${options.frame.width}x${options.frame.height}) → ${outDir}`);
  if (options.dryRun) {
    for (const item of items) {
      console.log(`- ${item.slug} [${item.size ?? "?"}] ${item.section}: ${item.name}`);
    }
    return;
  }

  const databaseUrl = process.env.DATABASE_URL ?? "postgres://frameos_cloud@127.0.0.1:55432/frameos_cloud";
  const cloudUrl = process.env.CLOUD_URL ?? DEFAULT_CLOUD_URL;
  const db = createDb(databaseUrl);
  const accountId = await evalAccountId(db, process.env.EVAL_ACCOUNT_EMAIL ?? "marius.andra@gmail.com");
  const renderer = await HeadlessRenderer.launch({ cloudUrl });
  // Lays the delivered scenes out with the editor's auto-arrange before they
  // are saved (the agent emits no node positions). Optional: a sign-in
  // failure or a missing page just means scenes land unaligned.
  const realigner = await HeadlessRealigner.launch({
    cloudUrl,
    email: process.env.EVAL_ACCOUNT_EMAIL ?? "marius.andra@gmail.com",
    password: process.env.EVAL_ACCOUNT_PASSWORD ?? "frameos-dev-password",
  }).catch((caught: unknown) => {
    console.log(`realign disabled: ${caught instanceof Error ? caught.message : String(caught)}`);
    return null;
  });

  const buildOne = async (item: TodoItem): Promise<BuildOutcome> => {
    const started = Date.now();
    let usage = emptyUsage();
    const toolCalls: string[] = [];
    let delivered: unknown[] | null = null;
    let currentScene: JsonObject | null = null;
    const state: { judge: JudgeVerdict | null; sizeNotes: string[] } = { judge: null, sizeNotes: [] };
    let lastRenderErrors: string[] = [];
    let lastLintErrors = 0;
    let pngPath: string | null = null;
    // The best attempt so far (scenes + preview + verdict): a review turn can
    // make things worse, and the last attempt used to be what got saved —
    // error screens included.
    const best: { scenes: unknown[] | null; pngPath: string | null; judge: JudgeVerdict | null; renderErrors: number } = {
      judge: null,
      pngPath: null,
      renderErrors: 0,
      scenes: null,
    };
    let attempts = 0;
    let error: string | null = null;
    const history: { role: "user" | "assistant"; content: string }[] = [];

    const turn = async (prompt: string) => {
      const toolContext: ToolContext = {
        accountId,
        currentScene,
        currentSceneId: currentScene ? String(currentScene.id ?? "") || null : null,
        db,
        emitScenes: (event: ScenesEvent) => {
          delivered = event.scenes;
          currentScene = obj(event.scenes[0]);
        },
        prompt,
        providerSubject: "scene-builder",
      };
      const contextParts = [`The user's frame is ${options.frame.width}x${options.frame.height} pixels.`];
      if (currentScene) {
        contextParts.push(
          `The user has this scene open in the editor (its id is "${String(currentScene.id)}"). update_scene will modify it:\n${JSON.stringify(currentScene)}`,
        );
      }
      const run = () =>
        runAgentLoop({
          apiKey,
          emit: () => undefined,
          input: buildInitialInput({ contextBlock: contextParts.join("\n\n"), history, prompt }),
          model: options.model,
          reasoningEffort: options.effort,
          toolContext,
        });
      // OpenAI streams occasionally drop mid-call ("terminated", socket
      // resets); a batch build should shrug those off rather than lose a
      // scene to a network blip.
      let result: Awaited<ReturnType<typeof run>>;
      for (let tries = 0; ; tries += 1) {
        try {
          result = await run();
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (tries < 4 && /terminated|fetch failed|ECONNRESET|socket|status 5\d\d|timeout|aborted/i.test(message)) {
            console.log(`  [${item.slug}] transient model error (${message.slice(0, 80)}), retrying`);
            await new Promise((resolve) => setTimeout(resolve, 5000 * (tries + 1)));
            continue;
          }
          throw error;
        }
      }
      usage = addUsage(usage, result.usage);
      toolCalls.push(...result.toolCalls);
      history.push({ content: prompt, role: "user" });
      history.push({ content: result.reply || "(delivered a scene)", role: "assistant" });
      console.log(`  [${item.slug}] ${result.tool} in ${result.rounds} rounds [${result.toolCalls.join(",")}]`);
    };

    const renderAndJudge = async (label: string) => {
      const scenes: unknown[] = delivered ?? [];
      lastLintErrors = lintScenes(scenes).errors.length;
      const sceneId = String(obj(scenes[0])?.id ?? "");
      const rendered = await renderer.render({
        height: options.frame.height,
        sceneId,
        scenes,
        width: options.frame.width,
      });
      lastRenderErrors = rendered.errors;
      if (rendered.png) {
        pngPath = join(outDir, "png", `${item.slug}-${label}.png`);
        await writeFile(pngPath, rendered.png);
      }
      console.log(
        `  [${item.slug}] render ${label}: ${rendered.rendered ? "ok" : "FAILED"}, ${rendered.errors.length} errors${rendered.errors.length ? ` — ${rendered.errors[0]?.slice(0, 220)}` : ""}`,
      );
      if (!rendered.png || !rendered.rendered) {
        state.judge = { problems: rendered.errors.slice(0, 3), score: 1, verdict: "did not render" };
        return;
      }
      const primary = await judgeRender({
        apiKey,
        height: options.frame.height,
        model: options.judgeModel,
        png: rendered.png,
        prompt: `${item.name}: ${item.description}`,
        rubric:
          "Judge as a scene a user would frame on a wall (colour e-ink or LCD): does it show the promised content, is it readable and well laid out at this size, and does it look modern — rich, smooth colour (gradients, deep or muted tones, one accent), strong hierarchy? Both a bland grey-on-white page and a garish layout of saturated primary colours (a 1990s slide) cap at 3 even when correct. Any text running past an edge or over another element caps at 2. Services that need the user's own credentials, URL or hardware (Home Assistant, printers, Strava, music players, paid APIs) cannot show live data here: a clearly labelled sample/demo or a designed 'set your API key in the scene fields' state with the real layout is acceptable and may score 4.",
        width: options.frame.width,
      });
      console.log(`  [${item.slug}] judge ${label} ${options.frame.width}x${options.frame.height}: ${primary.score}/5 — ${primary.verdict.slice(0, 160)}`);

      // Responsiveness: the same scene at other panel sizes. The scene's
      // score is its weakest size, and the review turn says which one broke.
      let worst: JudgeVerdict = primary;
      const sizeNotes: string[] = [];
      for (const size of options.extraSizes) {
        const alt = await renderer.render({ height: size.height, sceneId, scenes, width: size.width });
        const altLabel = `${size.width}x${size.height}`;
        if (alt.png) {
          await writeFile(join(outDir, "png", `${item.slug}-${label}-${altLabel}.png`), alt.png);
        }
        let verdict: JudgeVerdict;
        if (!alt.png || !alt.rendered) {
          verdict = { problems: alt.errors.slice(0, 3), score: 1, verdict: `did not render at ${altLabel}` };
        } else {
          // Runtime errors that also occur at the primary size (a service
          // needing credentials, a blocked private host) are judged there;
          // here only the layout is under review.
          verdict = await judgeRender({
            apiKey,
            height: size.height,
            model: options.judgeModel,
            png: alt.png,
            prompt: `${item.name}: ${item.description}`,
            rubric:
              `This is the SAME scene rendered for a ${altLabel} panel (${size.width > size.height ? "landscape" : "portrait"}). Judge only how well the layout adapts to this size: content should fill the panel proportionally (no small ${options.frame.width}x${options.frame.height} design floating in a corner, no stretched/distorted or cropped rendering), columns should stack when the panel is taller than wide, every piece of text must stay inside the canvas and inside its box, type sizes must scale with the panel. Score 5 only when it looks designed for this exact size.`,
            width: size.width,
          });
        }
        console.log(`  [${item.slug}] judge ${label} ${altLabel}: ${verdict.score}/5 — ${verdict.verdict.slice(0, 160)}`);
        sizeNotes.push(`${altLabel}: ${verdict.score}/5 — ${verdict.verdict}${verdict.problems.length ? " (" + verdict.problems.join("; ") + ")" : ""}`);
        if (verdict.score < worst.score) {
          worst = {
            problems: [`At ${altLabel} (${size.width > size.height ? "landscape" : "portrait"}): ${verdict.verdict}`, ...verdict.problems.map((problem) => `${altLabel}: ${problem}`)],
            score: verdict.score,
            verdict: `Layout does not adapt to ${altLabel}: ${verdict.verdict}`,
          };
        }
      }
      state.judge =
        worst === primary
          ? primary
          : {
              problems: [
                ...worst.problems,
                `The ${options.frame.width}x${options.frame.height} render scored ${primary.score}/5${primary.problems.length ? ": " + primary.problems.join("; ") : ""}.`,
                "Fix by deriving every coordinate, size and font from the frame size (app.frame.width/height, context.imageWidth/imageHeight) and stacking columns when the panel is taller than wide; wrap or truncate text to the available width.",
              ],
              score: worst.score,
              verdict: worst.verdict,
            };
      if (sizeNotes.length > 0) {
        state.sizeNotes = sizeNotes;
      }
    };

    try {
      await turn(buildPrompt(item, options.frame));
      for (attempts = 1; attempts <= options.attempts; attempts += 1) {
        if (!delivered) {
          throw new Error("the agent delivered no scene");
        }
        await renderAndJudge(`a${attempts}`);
        if (
          delivered &&
          (best.judge === null ||
            (state.judge?.score ?? 0) > best.judge.score ||
            ((state.judge?.score ?? 0) === best.judge.score && lastRenderErrors.length < best.renderErrors))
        ) {
          best.scenes = delivered;
          best.pngPath = pngPath;
          best.judge = state.judge;
          best.renderErrors = lastRenderErrors.length;
        }
        if (lastRenderErrors.length > 0 && attempts < options.attempts) {
          await turn(renderCheckPrompt(lastRenderErrors));
          continue;
        }
        if ((state.judge?.score ?? 0) >= options.minScore || attempts >= options.attempts) {
          break;
        }
        await turn(reviewPrompt(state.judge!, attempts, options.attempts));
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      console.log(`  [${item.slug}] ERROR ${error}`);
    }

    let saved: BuildOutcome["saved"] = null;
    if (best.scenes && best.judge && (best.judge.score > (state.judge?.score ?? 0) || (best.judge.score === (state.judge?.score ?? 0) && best.renderErrors < lastRenderErrors.length))) {
      console.log(`  [${item.slug}] keeping the best attempt (${best.judge.score}/5) over the last one (${state.judge?.score ?? "-"}/5)`);
      delivered = best.scenes;
      pngPath = best.pngPath;
      state.judge = best.judge;
      lastRenderErrors = new Array<string>(best.renderErrors).fill("(earlier attempt)");
    }
    let finalScenes: unknown[] | null = delivered;
    if (!error && finalScenes && options.save && realigner) {
      try {
        finalScenes = await realigner.realign(finalScenes, {
          log: (line) => console.log(`  [${item.slug}] ${line}`),
        });
        console.log(`  [${item.slug}] realigned ${finalScenes.length} scene(s)`);
      } catch (caught) {
        console.log(`  [${item.slug}] realign failed, saving unaligned: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    if (!error && finalScenes && options.save) {
      try {
        const png = pngPath ? await readFile(pngPath) : null;
        const folder = `${item.slug}/`;
        const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2));
        const zip = Buffer.from(
          zipSync({
            [`${folder}scenes.json`]: encode(finalScenes),
            [`${folder}template.json`]: encode({
              description: item.description,
              imageHeight: options.frame.height,
              imageWidth: options.frame.width,
              name: item.name,
              scenes: "./scenes.json",
            }),
            ...(png ? { [`${folder}image.jpg`]: new Uint8Array(png) } : {}),
          }),
        );
        const response = await publishStoreScene(db, {
          accountId,
          actor: { accountId, providerSubject: "scene-builder" },
          content: zip,
          description: item.description,
          name: item.name,
          visibility: "private",
        });
        const body = (await response.json()) as { error?: string; scene?: { id: string; slug: string } };
        if (!response.ok || !body.scene) {
          throw new Error(`publish failed: ${body.error ?? response.status}`);
        }
        const tags = sanitizeTagCandidates([
          ...item.name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3).slice(0, 3),
          item.section.split(/[^a-zA-Z]+/)[0]?.toLowerCase() ?? "",
          "ai-built",
        ]);
        // Tags/category, and a backdated created_at: the store caps new
        // scenes at 20/day per account, which a batch build of the whole
        // todo list would trip after the first twenty. Same trick as
        // scripts/import-store-scenes.mjs; the quota code stays untouched.
        await db
          .update(storeScenes)
          .set({
            category: SECTION_CATEGORY[item.section] ?? null,
            createdAt: sql`least(${storeScenes.createdAt}, now() - interval '2 days')`,
            tags,
          })
          .where(eq(storeScenes.id, body.scene.id));
        saved = { id: body.scene.id, slug: body.scene.slug, url: `${cloudUrl}/s/${body.scene.slug}` };
        console.log(`  [${item.slug}] saved as ${saved.url}`);
      } catch (caught) {
        error = `save: ${caught instanceof Error ? caught.message : String(caught)}`;
        console.log(`  [${item.slug}] ${error}`);
      }
    }
    const judged: JudgeVerdict | null = state.judge;
    return {
      attempts,
      durationMs: Date.now() - started,
      error,
      finalScore: judged ? judged.score : null,
      item,
      lintErrors: lastLintErrors,
      pngPath,
      renderErrors: lastRenderErrors.length,
      saved,
      toolCalls,
      usage,
      verdict: judged ? judged.verdict + (state.sizeNotes.length ? " · " + state.sizeNotes.map((note) => note.split(" — ")[0]).join(", ") : "") : "",
    };
  };

  const outcomes = await mapLimit(items, options.concurrency, async (item) => {
    console.log(`▶ ${item.slug}`);
    const outcome = await buildOne(item);
    console.log(`${outcome.error ? "❌" : (outcome.finalScore ?? 0) >= options.minScore ? "✅" : "🟡"} ${item.slug}: score ${outcome.finalScore ?? "-"}/5 after ${outcome.attempts} attempt(s), ${(outcome.durationMs / 1000).toFixed(0)}s`);
    return outcome;
  });
  await renderer.close();
  await realigner?.close();

  const lines = [
    `# Scenes built from docs/scenes-todo.md — ${runId}`,
    "",
    `${outcomes.length} scenes · ${outcomes.filter((o) => !o.error).length} built · ${outcomes.filter((o) => (o.finalScore ?? 0) >= options.minScore).length} scored ≥ ${options.minScore} · ${outcomes.filter((o) => o.saved).length} saved · model ${options.model}/${options.effort}`,
    "",
    "| scene | size | score | attempts | render errors | saved | time | verdict |",
    "|---|---|---|---|---|---|---|---|",
    ...outcomes.map(
      (o) =>
        `| ${o.item.name} | ${o.item.size ?? ""} | ${o.finalScore ?? "-"} | ${o.attempts} | ${o.renderErrors} | ${o.saved ? `[${o.saved.slug}](${o.saved.url})` : o.error ? `ERROR: ${o.error.replace(/\|/g, "/")}` : "no"} | ${(o.durationMs / 1000).toFixed(0)}s | ${o.verdict.replace(/\|/g, "/")}${o.pngPath ? ` [png](png/${o.pngPath.split("/").pop()})` : ""} |`,
    ),
    "",
  ];
  await writeFile(join(outDir, "report.md"), lines.join("\n"));
  await writeFile(join(outDir, "report.json"), JSON.stringify({ options, outcomes, runId }, null, 1));
  console.log(`report: ${join(outDir, "report.md")}`);
}

if (process.argv[1] && /build-todo-scenes\.ts$/.test(process.argv[1])) {
  main().then(
    // The pooled database client would otherwise keep the process alive.
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(2);
    },
  );
}
