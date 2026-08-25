// Turns eval results into the run record (JSON, the source of truth) and a
// markdown summary humans read; `compareRuns` diffs two runs case by case so
// a prompt or linter change shows what it moved.
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { EvalResult, EvalRun, EvalSummary } from "./types";

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarize(results: EvalResult[]): EvalSummary {
  const checks = results.flatMap((result) => result.checks);
  const judged = results.filter((result) => result.judge).map((result) => result.judge!.score);
  const rendered = results.filter((result) => result.render);
  const linted = results.filter((result) => result.lint);
  const byTag: EvalSummary["byTag"] = {};
  for (const result of results) {
    for (const tag of result.tags) {
      const entry = (byTag[tag] ??= { cases: 0, passed: 0 });
      entry.cases += 1;
      if (result.passed) {
        entry.passed += 1;
      }
    }
  }
  return {
    byTag,
    cases: results.length,
    checkPassRate: checks.length === 0 ? 0 : checks.filter((check) => check.passed).length / checks.length,
    deliveredRate:
      results.length === 0 ? 0 : results.filter((result) => result.deliveredScenes && result.deliveredScenes.length > 0).length / results.length,
    judgeMean: judged.length === 0 ? null : mean(judged),
    lintCleanRate: linted.length === 0 ? 0 : linted.filter((result) => result.lint!.errors.length === 0).length / linted.length,
    meanBounces: mean(results.map((result) => result.deliveryBounces)),
    meanDurationMs: mean(results.map((result) => result.durationMs)),
    meanRounds: mean(results.flatMap((result) => result.turns.filter((turn) => turn.role === "assistant").map((turn) => turn.rounds ?? 0))),
    passed: results.filter((result) => result.passed).length,
    renderOkRate:
      rendered.length === 0 ? 0 : rendered.filter((result) => result.render!.rendered && result.render!.errors.length === 0).length / rendered.length,
    totalInputTokens: results.reduce((sum, result) => sum + result.usage.inputTokens, 0),
    totalOutputTokens: results.reduce((sum, result) => sum + result.usage.outputTokens, 0),
  };
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function renderMarkdown(run: EvalRun, outDir: string): string {
  const s = run.summary;
  const lines: string[] = [];
  lines.push(`# AI scene evals — ${run.runId}`);
  lines.push("");
  lines.push(
    `Model **${run.model}** (effort ${run.reasoningEffort}) · ${s.cases} cases · **${s.passed}/${s.cases} passed** · checks ${pct(s.checkPassRate)} · delivered ${pct(s.deliveredRate)} · lint clean ${pct(s.lintCleanRate)} · render ok ${pct(s.renderOkRate)} · judge ${s.judgeMean === null ? "n/a" : s.judgeMean.toFixed(2) + "/5"}`,
  );
  lines.push(
    `Mean: ${s.meanRounds.toFixed(1)} model rounds/turn, ${s.meanBounces.toFixed(2)} delivery bounces/case, ${(s.meanDurationMs / 1000).toFixed(0)}s/case · tokens in ${s.totalInputTokens.toLocaleString()} / out ${s.totalOutputTokens.toLocaleString()}`,
  );
  lines.push("");
  const tags = Object.entries(s.byTag).sort(([a], [b]) => a.localeCompare(b));
  if (tags.length > 0) {
    lines.push("| tag | passed |");
    lines.push("|---|---|");
    for (const [tag, entry] of tags) {
      lines.push(`| ${tag} | ${entry.passed}/${entry.cases} |`);
    }
    lines.push("");
  }
  lines.push("| case | result | tool | rounds | bounces | render | judge | time | failed checks |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const result of run.results) {
    const rounds = result.turns.filter((turn) => turn.role === "assistant").map((turn) => turn.rounds ?? 0).join("+");
    const render = result.render
      ? result.render.rendered
        ? result.render.errors.length === 0
          ? "ok"
          : `${result.render.errors.length} err`
        : "FAIL"
      : "—";
    const png = result.render?.pngPath ? ` [png](${relative(outDir, result.render.pngPath)})` : "";
    const failed = result.checks
      .filter((check) => !check.passed)
      .map((check) => `${check.check.type}: ${check.detail}`)
      .join("<br>");
    lines.push(
      `| ${result.id} | ${result.error ? "ERROR" : result.passed ? "PASS" : "fail"} | ${result.deliveredTool} | ${rounds} | ${result.deliveryBounces} | ${render}${png} | ${result.judge ? result.judge.score : "—"} | ${(result.durationMs / 1000).toFixed(0)}s | ${result.error ? result.error.replace(/\|/g, "/") : failed.replace(/\|/g, "/")} |`,
    );
  }
  lines.push("");
  for (const result of run.results) {
    lines.push(`## ${result.id}`);
    lines.push("");
    lines.push(`Prompt: ${result.prompt}`);
    if (result.seedSlug) {
      lines.push(`Seed: ${result.seedSlug}`);
    }
    lines.push("");
    for (const turn of result.turns) {
      if (turn.role === "user") {
        lines.push(`> **user:** ${turn.content.replace(/\n/g, " ").slice(0, 400)}`);
      } else {
        lines.push(`> **assistant** (${turn.tool}, ${turn.rounds} rounds, [${(turn.toolCalls ?? []).join(", ")}]): ${turn.content.replace(/\n/g, " ").slice(0, 600)}`);
      }
      lines.push(">");
    }
    if (result.lint && (result.lint.errors.length > 0 || result.lint.warnings.length > 0)) {
      lines.push("");
      lines.push("Lint:");
      for (const issue of [...result.lint.errors, ...result.lint.warnings]) {
        lines.push(`- ${issue.level}: ${issue.message}`);
      }
    }
    if (result.render && result.render.errors.length > 0) {
      lines.push("");
      lines.push("Render errors:");
      for (const line of result.render.errors.slice(0, 8)) {
        lines.push(`- ${line.slice(0, 300)}`);
      }
    }
    if (result.render && result.judge && result.judge.score < 3 && result.render.logs.length > 0) {
      lines.push("");
      lines.push("Last runtime log lines:");
      for (const line of result.render.logs.slice(-12)) {
        lines.push(`- ${line.slice(0, 240)}`);
      }
    }
    if (result.judge) {
      lines.push("");
      lines.push(`Judge ${result.judge.score}/5: ${result.judge.verdict}${result.judge.problems.length ? " — " + result.judge.problems.join("; ") : ""}`);
    }
    lines.push("");
    lines.push("Checks:");
    for (const check of result.checks) {
      lines.push(`- ${check.passed ? "✅" : "❌"} ${check.check.type}: ${check.detail}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function writeRun(run: EvalRun, outDir: string): Promise<{ jsonPath: string; mdPath: string }> {
  const jsonPath = join(outDir, "report.json");
  const mdPath = join(outDir, "report.md");
  await writeFile(jsonPath, JSON.stringify(run, null, 1));
  await writeFile(mdPath, renderMarkdown(run, outDir));
  return { jsonPath, mdPath };
}

export async function compareRuns(beforePath: string, afterPath: string): Promise<string> {
  const before = JSON.parse(await readFile(beforePath, "utf8")) as EvalRun;
  const after = JSON.parse(await readFile(afterPath, "utf8")) as EvalRun;
  const beforeById = new Map(before.results.map((result) => [result.id, result]));
  const lines: string[] = [];
  lines.push(`# ${before.runId} → ${after.runId}`);
  lines.push("");
  const rows: [string, string, string][] = [
    ["passed", `${before.summary.passed}/${before.summary.cases}`, `${after.summary.passed}/${after.summary.cases}`],
    ["check pass rate", pct(before.summary.checkPassRate), pct(after.summary.checkPassRate)],
    ["lint clean", pct(before.summary.lintCleanRate), pct(after.summary.lintCleanRate)],
    ["render ok", pct(before.summary.renderOkRate), pct(after.summary.renderOkRate)],
    ["judge mean", before.summary.judgeMean?.toFixed(2) ?? "n/a", after.summary.judgeMean?.toFixed(2) ?? "n/a"],
    ["mean bounces", before.summary.meanBounces.toFixed(2), after.summary.meanBounces.toFixed(2)],
    ["mean rounds", before.summary.meanRounds.toFixed(2), after.summary.meanRounds.toFixed(2)],
    ["mean seconds", (before.summary.meanDurationMs / 1000).toFixed(0), (after.summary.meanDurationMs / 1000).toFixed(0)],
  ];
  lines.push("| metric | before | after |");
  lines.push("|---|---|---|");
  for (const [label, a, b] of rows) {
    lines.push(`| ${label} | ${a} | ${b} |`);
  }
  lines.push("");
  lines.push("| case | before | after |");
  lines.push("|---|---|---|");
  for (const result of after.results) {
    const previous = beforeById.get(result.id);
    const status = (entry: EvalResult | undefined) =>
      !entry ? "—" : entry.error ? "ERROR" : entry.passed ? "PASS" : `fail (${entry.checks.filter((c) => !c.passed).length})`;
    const marker = previous && previous.passed !== result.passed ? (result.passed ? " ⬆" : " ⬇") : "";
    lines.push(`| ${result.id} | ${status(previous)} | ${status(result)}${marker} |`);
  }
  return lines.join("\n");
}
