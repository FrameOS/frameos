// Merge eval runs into one baseline: later runs' cases replace earlier ones
// by id, the summary is recomputed, and the report (json + md + png) is
// written under evals/results/<name>. For the case where a run had to be
// repeated for a subset (an environment error on some cases) and the two
// halves should be compared against as one.
//
//   pnpm --filter @frameos-cloud/auth-web exec tsx evals/merge-runs.ts \
//     --out <name> evals/results/<first>/report.json evals/results/<second>/report.json
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { summarize, writeRun } from "./lib/report";
import type { EvalResult, EvalRun } from "./lib/types";

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  if (outIndex < 0 || args.length < outIndex + 3) {
    throw new Error("usage: merge-runs.ts --out <name> <report.json> <report.json> [...]");
  }
  const name = args[outIndex + 1] ?? "merged";
  const paths = args.filter((_, index) => index !== outIndex && index !== outIndex + 1);
  const runs: { path: string; run: EvalRun }[] = [];
  for (const path of paths) {
    runs.push({ path, run: JSON.parse(await readFile(path, "utf8")) as EvalRun });
  }
  const first = runs[0];
  if (!first) {
    throw new Error("nothing to merge");
  }
  const byId = new Map<string, { result: EvalResult; from: string }>();
  for (const { path, run } of runs) {
    if (run.model !== first.run.model) {
      throw new Error(`${path} ran ${run.model}, the first ran ${first.run.model}`);
    }
    for (const result of run.results) {
      byId.set(result.id, { from: dirname(path), result });
    }
  }
  const results = [...byId.values()].map((entry) => entry.result);
  const outDir = resolve(dirname(first.path), "..", name);
  await mkdir(join(outDir, "png"), { recursive: true });
  for (const { from } of byId.values()) {
    const pngDir = join(from, "png");
    const names = await readdir(pngDir).catch(() => [] as string[]);
    for (const file of names) {
      await copyFile(join(pngDir, file), join(outDir, "png", file));
    }
  }
  const last = runs[runs.length - 1] ?? first;
  const merged: EvalRun = {
    ...first.run,
    finishedAt: last.run.finishedAt,
    results,
    runId: name,
    summary: summarize(results),
  };
  const written = await writeRun(merged, outDir);
  console.log(`${results.length} cases from ${runs.length} runs -> ${written.mdPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
