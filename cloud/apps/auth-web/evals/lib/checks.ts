// Deterministic checks over what the agent delivered. Each returns a
// CheckResult with a one-line detail so a failing eval explains itself in
// the report without opening the JSON.
import type { LintResult } from "../../src/lib/ai/scene-lint";
import type { Check, CheckResult, JudgeVerdict, RenderSummary } from "./types";

type JsonObject = Record<string, unknown>;

export type CheckInput = {
  deliveredTool: string;
  scenes: unknown[] | null;
  seedScene: JsonObject | null;
  reply: string;
  lint: LintResult | null;
  render: RenderSummary | null;
  judge: JudgeVerdict | null;
};

function obj(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function nodesOf(scenes: unknown[]): JsonObject[] {
  return scenes.flatMap((scene) => {
    const nodes = obj(scene)?.nodes;
    return Array.isArray(nodes) ? nodes.map(obj).filter((node): node is JsonObject => Boolean(node)) : [];
  });
}

function fieldsOf(scenes: unknown[]): JsonObject[] {
  return scenes.flatMap((scene) => {
    const fields = obj(scene)?.fields;
    return Array.isArray(fields) ? fields.map(obj).filter((field): field is JsonObject => Boolean(field)) : [];
  });
}

// An app node "uses" a keyword when its keyword matches, or when it is a
// scene-local app whose origin is that repo app (weatherPanel -> repo/apps/code/weatherPanel).
function appKeywordsUsed(scenes: unknown[]): string[] {
  const keywords: string[] = [];
  for (const scene of scenes) {
    const entry = obj(scene);
    if (!entry) {
      continue;
    }
    const apps = obj(entry.apps) ?? {};
    for (const node of nodesOf([scene])) {
      if (node.type !== "app") {
        continue;
      }
      const keyword = obj(node.data)?.keyword;
      if (typeof keyword !== "string") {
        continue;
      }
      keywords.push(keyword);
      const origin = obj(apps[keyword])?.origin;
      if (typeof origin === "string") {
        keywords.push(origin);
      }
    }
  }
  return keywords;
}

function regex(pattern: string, flags?: string): RegExp {
  return new RegExp(pattern, flags ?? "i");
}

export function runCheck(check: Check, input: CheckInput): CheckResult {
  const scenes = input.scenes ?? [];
  const fail = (detail: string): CheckResult => ({ check, detail, passed: false });
  const pass = (detail: string): CheckResult => ({ check, detail, passed: true });

  switch (check.type) {
    case "delivered": {
      if (!input.scenes || input.scenes.length === 0) {
        return fail(`nothing delivered (tool: ${input.deliveredTool})`);
      }
      if (check.tool && input.deliveredTool !== check.tool) {
        return fail(`delivered via ${input.deliveredTool}, expected ${check.tool}`);
      }
      return pass(`delivered ${input.scenes.length} scene(s) via ${input.deliveredTool}`);
    }
    case "not_delivered":
      return input.scenes && input.scenes.length > 0
        ? fail(`delivered ${input.scenes.length} scene(s) but a reply was expected`)
        : pass("no scene delivered");
    case "app_used": {
      const count = appKeywordsUsed(scenes).filter((keyword) => keyword === check.keyword).length;
      const min = check.min ?? 1;
      return count >= min ? pass(`${check.keyword} used ${count}x`) : fail(`${check.keyword} used ${count}x, expected >= ${min}`);
    }
    case "app_not_used": {
      const count = appKeywordsUsed(scenes).filter((keyword) => keyword === check.keyword).length;
      return count === 0 ? pass(`${check.keyword} not used`) : fail(`${check.keyword} used ${count}x`);
    }
    case "any_app_used": {
      const used = new Set(appKeywordsUsed(scenes));
      const hit = check.keywords.find((keyword) => used.has(keyword));
      return hit ? pass(`uses ${hit}`) : fail(`none of ${check.keywords.join(", ")} used (has: ${[...used].join(", ") || "none"})`);
    }
    case "field_exists": {
      const field = fieldsOf(scenes).find((entry) => entry.name === check.name);
      if (!field) {
        return fail(`no scene field "${check.name}" (fields: ${fieldsOf(scenes).map((f) => f.name).join(", ") || "none"})`);
      }
      if (check.access && field.access !== check.access) {
        return fail(`field "${check.name}" has access ${String(field.access)}, expected ${check.access}`);
      }
      return pass(`field "${check.name}" exists`);
    }
    case "field_value": {
      const field = fieldsOf(scenes).find((entry) => entry.name === check.name);
      if (!field) {
        return fail(`no scene field "${check.name}"`);
      }
      const value = String(field.value ?? "");
      return regex(check.matches).test(value)
        ? pass(`field "${check.name}" = ${JSON.stringify(value)}`)
        : fail(`field "${check.name}" = ${JSON.stringify(value)} does not match /${check.matches}/`);
    }
    case "public_fields_min": {
      const count = fieldsOf(scenes).filter((field) => field.access === "public").length;
      return count >= check.min ? pass(`${count} public fields`) : fail(`${count} public fields, expected >= ${check.min}`);
    }
    case "refresh_interval": {
      const values = scenes
        .map((scene) => Number(obj(obj(scene)?.settings)?.refreshInterval))
        .filter((value) => Number.isFinite(value));
      if (values.length === 0) {
        return fail("no settings.refreshInterval set");
      }
      const value = values[0] as number;
      if (check.min !== undefined && value < check.min) {
        return fail(`refreshInterval ${value} < ${check.min}`);
      }
      if (check.max !== undefined && value > check.max) {
        return fail(`refreshInterval ${value} > ${check.max}`);
      }
      return pass(`refreshInterval ${value}`);
    }
    case "node_count": {
      const count = nodesOf(scenes).length;
      if (check.min !== undefined && count < check.min) {
        return fail(`${count} nodes < ${check.min}`);
      }
      if (check.max !== undefined && count > check.max) {
        return fail(`${count} nodes > ${check.max}`);
      }
      return pass(`${count} nodes`);
    }
    case "code_nodes_min": {
      const count = nodesOf(scenes).filter((node) => node.type === "code").length;
      return count >= check.min ? pass(`${count} code nodes`) : fail(`${count} code nodes < ${check.min}`);
    }
    case "scene_count": {
      const count = scenes.length;
      if (check.min !== undefined && count < check.min) {
        return fail(`${count} scenes < ${check.min}`);
      }
      if (check.max !== undefined && count > check.max) {
        return fail(`${count} scenes > ${check.max}`);
      }
      return pass(`${count} scenes`);
    }
    case "json_matches": {
      const text = JSON.stringify(scenes);
      return regex(check.pattern, check.flags).test(text)
        ? pass(`scene JSON matches /${check.pattern}/`)
        : fail(`scene JSON does not match /${check.pattern}/`);
    }
    case "json_not_matches": {
      const text = JSON.stringify(scenes);
      return regex(check.pattern, check.flags).test(text)
        ? fail(`scene JSON matches /${check.pattern}/ but should not`)
        : pass(`scene JSON avoids /${check.pattern}/`);
    }
    case "reply_matches":
      return regex(check.pattern, check.flags).test(input.reply)
        ? pass(`reply matches /${check.pattern}/`)
        : fail(`reply does not match /${check.pattern}/: ${input.reply.slice(0, 160).replace(/\s+/g, " ")}`);
    case "preserves_node_ids": {
      if (!input.seedScene) {
        return fail("no seed scene to compare against");
      }
      const before = new Set(nodesOf([input.seedScene]).map((node) => String(node.id)));
      const after = new Set(nodesOf(scenes).map((node) => String(node.id)));
      const kept = [...before].filter((id) => after.has(id)).length;
      const fraction = before.size === 0 ? 1 : kept / before.size;
      return fraction >= check.minFraction
        ? pass(`${kept}/${before.size} node ids preserved`)
        : fail(`${kept}/${before.size} node ids preserved (${fraction.toFixed(2)} < ${check.minFraction})`);
    }
    case "preserves_fields": {
      if (!input.seedScene) {
        return fail("no seed scene to compare against");
      }
      const before = fieldsOf([input.seedScene]).map((field) => String(field.name));
      const after = new Set(fieldsOf(scenes).map((field) => String(field.name)));
      const missing = before.filter((name) => !after.has(name));
      return missing.length === 0
        ? pass(`all ${before.length} fields kept`)
        : fail(`dropped fields: ${missing.join(", ")}`);
    }
    case "lint_clean": {
      if (!input.lint) {
        return fail("no lint result");
      }
      const errors = input.lint.errors.length;
      const warnings = input.lint.warnings.length;
      return errors === 0
        ? pass(`0 lint errors, ${warnings} warnings`)
        : fail(`${errors} lint errors: ${input.lint.errors.map((issue) => issue.message).join(" | ").slice(0, 300)}`);
    }
    case "render_ok": {
      if (!input.render) {
        return fail("no render result");
      }
      if (!input.render.rendered) {
        return fail(`did not render: ${input.render.errors.join(" | ").slice(0, 300)}`);
      }
      return input.render.errors.length === 0
        ? pass(`rendered in ${input.render.renderMs ?? "?"}ms without errors`)
        : fail(`rendered with ${input.render.errors.length} error(s): ${input.render.errors.join(" | ").slice(0, 300)}`);
    }
    case "render_not_blank": {
      const stats = input.render?.pixelStats;
      if (!input.render?.rendered || !stats) {
        return fail("no frame to inspect");
      }
      const min = check.minInkFraction ?? 0.01;
      return stats.inkFraction >= min
        ? pass(`ink ${(stats.inkFraction * 100).toFixed(1)}%, ${stats.distinctColors} colours`)
        : fail(`frame looks blank: ink ${(stats.inkFraction * 100).toFixed(2)}% < ${(min * 100).toFixed(1)}%`);
    }
    case "judge": {
      if (!input.judge) {
        return fail("no judge verdict");
      }
      return input.judge.score >= check.min
        ? pass(`judge ${input.judge.score}/5: ${input.judge.verdict}`)
        : fail(`judge ${input.judge.score}/5 < ${check.min}: ${input.judge.verdict}${input.judge.problems.length ? " — " + input.judge.problems.join("; ") : ""}`);
    }
  }
}

export function runChecks(checks: Check[], input: CheckInput): CheckResult[] {
  return checks.map((check) => runCheck(check, input));
}

/** True when a case's checks need a rendered frame. */
export function needsRender(checks: Check[]): boolean {
  return checks.some((check) => check.type === "render_ok" || check.type === "render_not_blank" || check.type === "judge");
}

export function needsJudge(checks: Check[]): boolean {
  return checks.some((check) => check.type === "judge");
}
