// Model comparison for the AI scene evals.
//
//   pnpm --filter @frameos-cloud/auth-web ai:eval:models
//       [--models gpt-5.5,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna]
//       [--only id,id] [--filter tag,tag] [--all] [--no-render] [--no-judge]
//       [--concurrency 3] [--effort low] [--out evals/results/models-<runId>]
//
// Runs the SAME case subset against each model in turn (cases concurrent
// within a model, models sequential so one shared renderer and a fair rate
// budget), then writes a combined comparison. The vision judge is pinned to
// DEFAULT_JUDGE_MODEL for every run so the grader never varies with the
// candidate. Defaults to QUICK_SET — 9 cases spanning code, svg, network,
// fields, layout, modify and ask — rather than the full suite, because the
// point is a model decision, not exhaustive coverage; pass --all for the
// whole suite.
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { createDb } from "@frameos-cloud/db";
import { DEFAULT_REASONING_EFFORT } from "../src/lib/ai/openai";
import { DEFAULT_CLOUD_URL, HeadlessRenderer } from "../src/lib/ai/eval/render-check";
import { selectCases } from "./cases/scenes";
import { DEFAULT_JUDGE_MODEL } from "./lib/judge";
import { summarize, writeRun } from "./lib/report";
import { runCase, type RunnerContext } from "./lib/runner";
import { evalAccountId } from "./lib/store";
import type { EvalResult, EvalRun } from "./lib/types";

export const DEFAULT_MODELS = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

// One case per capability the chat leans on, instead of the whole suite:
// simple create, code-heavy create, network/data, svg+portrait, fields,
// field edit, text/data edit, layout edit, and a must-not-deliver ask.
export const QUICK_SET = [
  "create-big-clock",
  "create-word-clock",
  "create-rss-headlines",
  "create-analog-clock",
  "create-countdown",
  "modify-weather-fahrenheit",
  "modify-xkcd-title",
  "modify-github-stars-portrait",
  "ask-explain-message-board",
];

// USD per 1M tokens (standard tier, non-long-context). gpt-5.6-sol is the
// promotional price ("at least through November 21, 2026"). Models not
// listed get no cost estimate rather than a wrong one.
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-5.5": { cached: 0.5, input: 5, output: 30 },
  "gpt-5.6-luna": { cached: 0.02, input: 0.2, output: 1.2 },
  "gpt-5.6-sol": { cached: 0.4, input: 4, output: 20 },
  "gpt-5.6-terra": { cached: 0.2, input: 2, output: 12 },
};

type Options = {
  models: string[];
  only: string[];
  filter: string[];
  all: boolean;
  render: boolean;
  judge: boolean;
  concurrency: number;
  effort: string;
  out: string | null;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    all: false,
    concurrency: 3,
    effort: DEFAULT_REASONING_EFFORT,
    filter: [],
    judge: true,
    models: DEFAULT_MODELS,
    only: [],
    out: null,
    render: true,
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
      case "--models":
        options.models = value().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--only":
        options.only = value().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--filter":
        options.filter = value().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--all":
        options.all = true;
        break;
      case "--no-render":
        options.render = false;
        break;
      case "--no-judge":
        options.judge = false;
        break;
      case "--concurrency":
        options.concurrency = Math.max(1, Number(value()) || 1);
        break;
      case "--effort":
        options.effort = value();
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
        const loader = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile;
        loader?.call(process, candidate);
      } catch {
        // malformed line in a hand-edited env file; the important keys are usually earlier
      }
      break;
    }
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function estimatedCostUsd(run: EvalRun): number | null {
  const price = PRICES[run.model];
  if (!price) {
    return null;
  }
  let cost = 0;
  for (const result of run.results) {
    const uncached = Math.max(0, result.usage.inputTokens - result.usage.cachedInputTokens);
    cost +=
      (uncached * price.input + result.usage.cachedInputTokens * price.cached + result.usage.outputTokens * price.output) /
      1_000_000;
  }
  return cost;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function renderComparison(runs: EvalRun[], runId: string): string {
  const lines: string[] = [];
  lines.push(`# AI scene evals — model comparison ${runId}`);
  lines.push("");
  lines.push(
    `${runs[0]?.results.length ?? 0} cases per model (effort ${runs[0]?.reasoningEffort}), judge ${DEFAULT_JUDGE_MODEL} throughout.`,
  );
  lines.push("");
  const header = ["metric", ...runs.map((run) => run.model)];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  const rows: [string, (run: EvalRun) => string][] = [
    ["passed", (run) => `${run.summary.passed}/${run.summary.cases}`],
    ["check pass rate", (run) => pct(run.summary.checkPassRate)],
    ["lint clean", (run) => pct(run.summary.lintCleanRate)],
    ["render ok", (run) => pct(run.summary.renderOkRate)],
    ["judge mean", (run) => run.summary.judgeMean?.toFixed(2) ?? "n/a"],
    ["delivery bounces/case", (run) => run.summary.meanBounces.toFixed(2)],
    ["model rounds/turn", (run) => run.summary.meanRounds.toFixed(1)],
    ["seconds/case", (run) => (run.summary.meanDurationMs / 1000).toFixed(0)],
    [
      "tokens in/out",
      (run) => `${(run.summary.totalInputTokens / 1000).toFixed(0)}k/${(run.summary.totalOutputTokens / 1000).toFixed(0)}k`,
    ],
    [
      "est. cost (run)",
      (run) => {
        const cost = estimatedCostUsd(run);
        return cost === null ? "?" : `$${cost.toFixed(2)}`;
      },
    ],
    [
      "est. cost/case",
      (run) => {
        const cost = estimatedCostUsd(run);
        return cost === null || run.results.length === 0 ? "?" : `$${(cost / run.results.length).toFixed(3)}`;
      },
    ],
  ];
  for (const [label, cell] of rows) {
    lines.push(`| ${label} | ${runs.map(cell).join(" | ")} |`);
  }
  lines.push("");
  lines.push(`| case | ${runs.map((run) => run.model).join(" | ")} |`);
  lines.push(`|---|${runs.map(() => "---").join("|")}|`);
  const caseIds = runs[0]?.results.map((result) => result.id) ?? [];
  for (const id of caseIds) {
    const cells = runs.map((run) => {
      const result = run.results.find((r) => r.id === id);
      if (!result) {
        return "—";
      }
      const status = result.error ? "ERROR" : result.passed ? "PASS" : `fail(${result.checks.filter((c) => !c.passed).length})`;
      return `${status}${result.judge ? ` ${result.judge.score}/5` : ""}${result.deliveryBounces ? ` b${result.deliveryBounces}` : ""}`;
    });
    lines.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("Cells: PASS/fail(n failed checks), judge score, bN = delivery bounces.");
  lines.push("Per-model detail: `<model>/report.md` next to this file.");
  return lines.join("\n");
}

function runIdNow(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function main() {
  loadEnv();
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required (set it or put it in cloud/.env.local)");
  }
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://frameos_cloud@127.0.0.1:55432/frameos_cloud";
  const cloudUrl = process.env.CLOUD_URL ?? DEFAULT_CLOUD_URL;
  const accountEmail = process.env.EVAL_ACCOUNT_EMAIL ?? "marius.andra@gmail.com";
  const only = options.only.length > 0 ? options.only : options.all || options.filter.length > 0 ? [] : QUICK_SET;
  const selected = selectCases({ filter: options.filter, only });
  if (selected.length === 0) {
    throw new Error("no cases selected");
  }
  const runId = runIdNow();
  const outDir = resolve(options.out ?? join("evals", "results", `models-${runId}`));
  await mkdir(outDir, { recursive: true });

  const db = createDb(databaseUrl);
  const accountId = await evalAccountId(db, accountEmail);
  const renderer = options.render ? await HeadlessRenderer.launch({ cloudUrl }) : null;
  const log = (line: string) => console.log(line);
  log(
    `model comparison ${runId}: ${selected.length} cases × [${options.models.join(", ")}], effort ${options.effort}, render ${options.render ? "on" : "off"}, judge ${options.judge ? DEFAULT_JUDGE_MODEL : "off"}, out ${outDir}`,
  );

  const runs: EvalRun[] = [];
  for (const model of options.models) {
    const modelDir = join(outDir, model.replace(/[^a-z0-9.-]/gi, "_"));
    await mkdir(modelDir, { recursive: true });
    log("");
    log(`━━ ${model} ━━`);
    const startedAt = new Date().toISOString();
    const context: RunnerContext = {
      accountId,
      apiKey,
      db,
      judge: options.judge,
      judgeModel: DEFAULT_JUDGE_MODEL,
      log,
      model,
      outDir: modelDir,
      reasoningEffort: options.effort,
      renderer,
    };
    const results: EvalResult[] = await mapLimit(selected, options.concurrency, async (evalCase) => {
      log(`▶ [${model}] ${evalCase.id}`);
      const result = await runCase(evalCase, context);
      log(`${result.passed ? "✅" : "❌"} [${model}] ${evalCase.id} (${(result.durationMs / 1000).toFixed(0)}s)${result.error ? ` ERROR ${result.error}` : ""}`);
      return result;
    });
    const run: EvalRun = {
      cloudUrl,
      finishedAt: new Date().toISOString(),
      model,
      options: { ...options },
      reasoningEffort: options.effort,
      results,
      runId: `${runId}-${model}`,
      startedAt,
      summary: summarize(results),
    };
    await writeRun(run, modelDir);
    runs.push(run);
    const s = run.summary;
    const cost = estimatedCostUsd(run);
    log(
      `━━ ${model}: ${s.passed}/${s.cases} passed · judge ${s.judgeMean?.toFixed(2) ?? "n/a"} · bounces ${s.meanBounces.toFixed(2)} · ${cost === null ? "cost ?" : `~$${cost.toFixed(2)}`} ━━`,
    );
  }
  await renderer?.close();

  const comparison = renderComparison(runs, runId);
  const mdPath = join(outDir, "compare.md");
  await writeFile(mdPath, comparison);
  await writeFile(join(outDir, "compare.json"), JSON.stringify({ runId, runs }, null, 1));
  log("");
  log(comparison);
  log("");
  log(`comparison: ${mdPath}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
