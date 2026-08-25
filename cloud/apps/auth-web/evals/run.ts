// AI scene evals runner.
//
//   pnpm --filter @frameos-cloud/auth-web ai:eval [--only id,id] [--filter tag,tag] [--no-render]
//       [--no-judge] [--concurrency 3] [--model gpt-5.5] [--effort low] [--out evals/results/<runId>]
//       [--compare path/to/other/report.json]
//
// Needs: the cloud dev server on CLOUD_URL (default http://localhost:3000) for
// rendering, DATABASE_URL (default the local dev database) holding the
// imported store scenes, and OPENAI_API_KEY (read from cloud/.env.local when
// not set). The eval account is EVAL_ACCOUNT_EMAIL (default the importer's).
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { createDb } from "@frameos-cloud/db";
import { DEFAULT_CHAT_MODEL, DEFAULT_REASONING_EFFORT } from "../src/lib/ai/openai";
import { DEFAULT_CLOUD_URL, HeadlessRenderer } from "../src/lib/ai/eval/render-check";
import { selectCases } from "./cases/scenes";
import { DEFAULT_JUDGE_MODEL } from "./lib/judge";
import { compareRuns, summarize, writeRun } from "./lib/report";
import { runCase, type RunnerContext } from "./lib/runner";
import { evalAccountId } from "./lib/store";
import type { EvalResult, EvalRun } from "./lib/types";

type Options = {
  only: string[];
  filter: string[];
  render: boolean;
  judge: boolean;
  concurrency: number;
  model: string;
  effort: string;
  judgeModel: string;
  out: string | null;
  compare: string | null;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    compare: null,
    concurrency: 3,
    effort: DEFAULT_REASONING_EFFORT,
    filter: [],
    judge: true,
    judgeModel: DEFAULT_JUDGE_MODEL,
    model: DEFAULT_CHAT_MODEL,
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
      case "--only":
        options.only = value().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--filter":
        options.filter = value().split(",").map((s) => s.trim()).filter(Boolean);
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
      case "--compare":
        options.compare = value();
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

function loadEnv(): void {
  // tsx does not load .env files; the cloud's local config lives one level
  // above the app (cloud/.env.local, symlinked into apps/auth-web).
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
  const selected = selectCases({ filter: options.filter, only: options.only });
  if (selected.length === 0) {
    throw new Error("no cases selected");
  }
  const runId = runIdNow();
  const outDir = resolve(options.out ?? join("evals", "results", runId));
  await mkdir(outDir, { recursive: true });

  const db = createDb(databaseUrl);
  const accountId = await evalAccountId(db, accountEmail);
  const renderer = options.render ? await HeadlessRenderer.launch({ cloudUrl }) : null;
  const log = (line: string) => console.log(line);
  log(`eval run ${runId}: ${selected.length} cases, model ${options.model}/${options.effort}, render ${options.render ? "on" : "off"}, judge ${options.judge ? options.judgeModel : "off"}, out ${outDir}`);

  const startedAt = new Date().toISOString();
  const context: RunnerContext = {
    accountId,
    apiKey,
    db,
    judge: options.judge,
    judgeModel: options.judgeModel,
    log,
    model: options.model,
    outDir,
    reasoningEffort: options.effort,
    renderer,
  };
  const results: EvalResult[] = await mapLimit(selected, options.concurrency, async (evalCase) => {
    log(`▶ ${evalCase.id}`);
    const result = await runCase(evalCase, context);
    log(`${result.passed ? "✅" : "❌"} ${evalCase.id} (${(result.durationMs / 1000).toFixed(0)}s)${result.error ? ` ERROR ${result.error}` : ""}`);
    return result;
  });
  await renderer?.close();

  const run: EvalRun = {
    cloudUrl,
    finishedAt: new Date().toISOString(),
    model: options.model,
    options: { ...options },
    reasoningEffort: options.effort,
    results,
    runId,
    startedAt,
    summary: summarize(results),
  };
  const { jsonPath, mdPath } = await writeRun(run, outDir);
  const s = run.summary;
  log("");
  log(`${s.passed}/${s.cases} passed · checks ${Math.round(s.checkPassRate * 100)}% · lint clean ${Math.round(s.lintCleanRate * 100)}% · render ok ${Math.round(s.renderOkRate * 100)}% · judge ${s.judgeMean?.toFixed(2) ?? "n/a"} · bounces ${s.meanBounces.toFixed(2)} · tokens ${s.totalInputTokens}/${s.totalOutputTokens}`);
  log(`report: ${mdPath} (${jsonPath})`);
  if (options.compare) {
    log("");
    log(await compareRuns(resolve(options.compare), jsonPath));
  }
  process.exit(s.passed === s.cases ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
