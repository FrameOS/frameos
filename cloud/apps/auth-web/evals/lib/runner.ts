// Runs one eval case through the real agent loop, the same way the store's
// AI panel does: prompt -> tools -> delivered scenes -> in-runtime render
// check -> (on errors) an automatic follow-up turn, at most twice. Then the
// deterministic checks and the optional vision judge grade the outcome.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildInitialInput, runAgentLoop } from "../../src/lib/ai/loop";
import { addUsage, emptyUsage, type ResponseUsage } from "../../src/lib/ai/openai";
import { lintScenes } from "../../src/lib/ai/scene-lint";
import type { ScenesEvent, ToolContext } from "../../src/lib/ai/tools";
import type { HeadlessRenderer } from "../../src/lib/ai/eval/render-check";
import { needsJudge, needsRender, runChecks } from "./checks";
import { judgeRender } from "./judge";
import { loadStoreSceneBySlug, type Db } from "./store";
import type { EvalCase, EvalResult, JudgeVerdict, RenderSummary, TurnRecord } from "./types";

type JsonObject = Record<string, unknown>;

export const MAX_RENDER_CHECK_ROUNDS = 2;
export const RENDER_CHECK_PREFIX = "[Automatic render check]";
const DEFAULT_FRAME = { height: 480, width: 800 };

export type RunnerContext = {
  db: Db;
  accountId: string;
  apiKey: string;
  model: string;
  reasoningEffort: string;
  judgeModel: string;
  renderer: HeadlessRenderer | null;
  judge: boolean;
  outDir: string;
  log: (line: string) => void;
  signal?: AbortSignal;
};

function obj(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function sceneSummaryForContext(scene: JsonObject): string {
  return JSON.stringify(scene);
}

function renderCheckPrompt(errors: string[]): string {
  const unique = [...new Set(errors)].slice(0, 8);
  return (
    `${RENDER_CHECK_PREFIX} The scene was rendered in the FrameOS runtime and logged these errors:\n` +
    unique.map((line) => `- ${line}`).join("\n") +
    "\nFix the scene so it renders without errors and deliver the corrected version with the same tool."
  );
}

export async function runCase(evalCase: EvalCase, ctx: RunnerContext): Promise<EvalResult> {
  const startedAt = new Date();
  const frame = evalCase.frame ?? DEFAULT_FRAME;
  const turns: TurnRecord[] = [];
  let usage: ResponseUsage = emptyUsage();
  let deliveredScenes: unknown[] | null = null;
  let deliveredTool = "reply";
  // The tool of the FIRST delivery: a render-check follow-up re-delivers via
  // update_scene, which must not turn a "built a new scene" case into a
  // "modified" one.
  let firstDeliveredTool: string | null = null;
  let deliveryBounces = 0;
  let renderCheckRounds = 0;
  let render: RenderSummary | null = null;
  let judge: JudgeVerdict | null = null;
  let lint: ReturnType<typeof lintScenes> | null = null;
  let error: string | null = null;
  let seedScene: JsonObject | null = null;
  let storeSceneId: string | null = null;
  let reply = "";

  try {
    if (evalCase.seedSlug) {
      const loaded = await loadStoreSceneBySlug(ctx.db, evalCase.seedSlug);
      storeSceneId = loaded.id;
      const first = obj(loaded.scenes.find((scene) => obj(scene)?.default) ?? loaded.scenes[0]);
      if (!first) {
        throw new Error(`seed scene ${evalCase.seedSlug} is empty`);
      }
      seedScene = first;
    }

    const history: { role: "user" | "assistant"; content: string }[] = [];
    let currentScene: JsonObject | null = seedScene;
    const editorScenes: unknown[] | null = seedScene ? [seedScene] : null;

    const runTurn = async (prompt: string, isRenderCheck: boolean) => {
      const turnStart = Date.now();
      let bouncesThisTurn = 0;
      const toolContext: ToolContext = {
        accountId: ctx.accountId,
        currentScene,
        currentSceneId: currentScene ? String(currentScene.id ?? "") || null : null,
        db: ctx.db,
        editorScenes,
        emitScenes: (event: ScenesEvent) => {
          deliveredScenes = event.scenes;
          deliveredTool = event.tool;
          firstDeliveredTool ??= event.tool;
          const first = obj(event.scenes[0]);
          if (first) {
            currentScene = first;
          }
        },
        prompt,
        providerSubject: "evals",
        storeSceneId,
      };
      const contextParts: string[] = [
        `The user's frame is ${frame.width}x${frame.height} pixels (a ${frame.width >= frame.height ? "landscape" : "portrait"} panel).`,
      ];
      if (storeSceneId && seedScene) {
        contextParts.push(
          `The user is on the scene store, looking at store scene ${storeSceneId} ("${String(seedScene.name)}") in its editor. They do not own it; their edits are saved as a fork.`,
        );
      }
      if (currentScene) {
        contextParts.push(
          `The user has this scene open in the editor (its id is "${String(currentScene.id)}"). update_scene will modify it:\n` +
            sceneSummaryForContext(currentScene),
        );
      }
      const run = () => runAgentLoop({
        apiKey: ctx.apiKey,
        emit: (event) => {
          if (event.type === "tool" && event.status === "done") {
            // A delivery tool that returned ok:false shows up as a "done"
            // without a scenes event; count those as bounces below.
          }
          if (event.type === "tool" && event.status === "error") {
            ctx.log(`  [${evalCase.id}] tool ${event.name} errored: ${event.detail ?? ""}`);
          }
        },
        input: buildInitialInput({ contextBlock: contextParts.join("\n\n"), history, prompt }),
        model: ctx.model,
        reasoningEffort: ctx.reasoningEffort,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        toolContext,
      });
      // OpenAI streams occasionally drop mid-call; that is not the model's
      // scene-building ability under test, so retry with a short backoff.
      let result: Awaited<ReturnType<typeof run>>;
      for (let tries = 0; ; tries += 1) {
        try {
          result = await run();
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (tries < 3 && /terminated|fetch failed|ECONNRESET|socket|status 5\d\d|timeout|aborted/i.test(message)) {
            ctx.log(`  [${evalCase.id}] transient model error (${message.slice(0, 80)}), retrying`);
            await new Promise((resolve) => setTimeout(resolve, 5000 * (tries + 1)));
            continue;
          }
          throw error;
        }
      }
      // Bounces: delivery tool calls beyond the one that succeeded.
      const deliveryCalls = result.toolCalls.filter((name) => name === "create_scenes" || name === "update_scene").length;
      bouncesThisTurn = Math.max(0, deliveryCalls - (toolContext.deliveredTool ? 1 : 0));
      deliveryBounces += bouncesThisTurn;
      usage = addUsage(usage, result.usage);
      reply = result.reply;
      turns.push({ content: prompt, role: "user" });
      turns.push({
        content: result.reply,
        ms: Date.now() - turnStart,
        role: "assistant",
        rounds: result.rounds,
        tool: result.tool,
        toolCalls: result.toolCalls,
        usage: result.usage,
      });
      history.push({ content: prompt, role: "user" });
      history.push({ content: result.reply || "(delivered a scene)", role: "assistant" });
      ctx.log(
        `  [${evalCase.id}] ${isRenderCheck ? "render-check turn" : "turn"}: ${result.tool}, ${result.rounds} rounds, tools=[${result.toolCalls.join(",")}], ${bouncesThisTurn} bounces, ${Math.round((Date.now() - turnStart) / 1000)}s`,
      );
    };

    await runTurn(evalCase.prompt, false);

    const wantRender = needsRender(evalCase.checks) && ctx.renderer !== null;
    for (let round = 0; ; round += 1) {
      if (!deliveredScenes) {
        break;
      }
      const scenes: unknown[] = deliveredScenes;
      lint = lintScenes(scenes);
      if (!wantRender || !ctx.renderer) {
        break;
      }
      const sceneId = String(obj(scenes[0])?.id ?? "");
      const rendered = await ctx.renderer.render({
        height: frame.height,
        scenes,
        ...(sceneId ? { sceneId } : {}),
        ...(evalCase.settings ? { settings: evalCase.settings } : {}),
        width: frame.width,
      });
      let pngPath: string | null = null;
      if (rendered.png) {
        await mkdir(join(ctx.outDir, "png"), { recursive: true });
        pngPath = join(ctx.outDir, "png", `${evalCase.id}${round > 0 ? `-r${round}` : ""}.png`);
        await writeFile(pngPath, rendered.png);
      }
      render = {
        errors: rendered.errors,
        logs: rendered.logs.slice(-40),
        pixelStats: rendered.pixelStats,
        pngPath,
        renderMs: rendered.renderMs,
        rendered: rendered.rendered,
      };
      ctx.log(
        `  [${evalCase.id}] render: ${rendered.rendered ? `ok in ${rendered.renderMs}ms` : "FAILED"}, ${rendered.errors.length} errors, ink ${rendered.pixelStats ? (rendered.pixelStats.inkFraction * 100).toFixed(1) + "%" : "?"}`,
      );
      if (rendered.errors.length === 0 || round >= MAX_RENDER_CHECK_ROUNDS) {
        break;
      }
      renderCheckRounds += 1;
      await runTurn(renderCheckPrompt(rendered.errors), true);
    }

    if (deliveredScenes && render?.pngPath && ctx.judge && needsJudge(evalCase.checks)) {
      const { readFile } = await import("node:fs/promises");
      const png = await readFile(render.pngPath);
      judge = await judgeRender({
        apiKey: ctx.apiKey,
        height: frame.height,
        model: ctx.judgeModel,
        png,
        prompt: evalCase.prompt,
        rubric: evalCase.judgeRubric,
        width: frame.width,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      ctx.log(`  [${evalCase.id}] judge: ${judge.score}/5 — ${judge.verdict}`);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    ctx.log(`  [${evalCase.id}] ERROR: ${error}`);
  }

  const checks = runChecks(evalCase.checks, {
    deliveredTool: firstDeliveredTool ?? deliveredTool,
    judge,
    lint,
    render,
    reply,
    scenes: deliveredScenes,
    seedScene,
  });
  return {
    checks,
    deliveredScenes,
    deliveredTool,
    deliveryBounces,
    durationMs: Date.now() - startedAt.getTime(),
    error,
    frame,
    id: evalCase.id,
    judge,
    lint,
    model: ctx.model,
    passed: error === null && checks.every((check) => check.passed),
    prompt: evalCase.prompt,
    reasoningEffort: ctx.reasoningEffort,
    render,
    renderCheckRounds,
    seedSlug: evalCase.seedSlug ?? null,
    startedAt: startedAt.toISOString(),
    tags: evalCase.tags,
    turns,
    usage,
  };
}
