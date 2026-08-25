// Shared shapes for the AI scene evals. A case is one user request against
// the real agent loop (real OpenAI, real app catalog, real store database);
// the result records what the agent did, what it delivered, how the scene
// lints and renders, and how each check judged it.
import type { LintIssue } from "../../src/lib/ai/scene-lint";
import type { ResponseUsage } from "../../src/lib/ai/openai";
import type { PixelStats } from "../../src/lib/ai/eval/render-check";

export type FrameSize = { width: number; height: number };

export type Check =
  | { type: "delivered"; tool?: "build_scene" | "modify_scene" }
  | { type: "not_delivered" }
  | { type: "app_used"; keyword: string; min?: number }
  | { type: "app_not_used"; keyword: string }
  | { type: "any_app_used"; keywords: string[] }
  | { type: "field_exists"; name: string; access?: "public" | "private" }
  | { type: "field_value"; name: string; matches: string }
  | { type: "public_fields_min"; min: number }
  | { type: "refresh_interval"; min?: number; max?: number }
  | { type: "node_count"; min?: number; max?: number }
  | { type: "code_nodes_min"; min: number }
  | { type: "scene_count"; min?: number; max?: number }
  | { type: "json_matches"; pattern: string; flags?: string }
  | { type: "json_not_matches"; pattern: string; flags?: string }
  | { type: "reply_matches"; pattern: string; flags?: string }
  | { type: "preserves_node_ids"; minFraction: number }
  | { type: "preserves_fields" }
  | { type: "lint_clean" }
  | { type: "render_ok" }
  | { type: "render_not_blank"; minInkFraction?: number }
  | { type: "judge"; min: number };

export type EvalCase = {
  id: string;
  /** Free-form tags for --filter (e.g. "create", "modify", "data", "svg"). */
  tags: string[];
  prompt: string;
  /** Slug of a store scene to open in the editor before prompting. */
  seedSlug?: string;
  frame?: FrameSize;
  /** Frame settings handed to the render check (API keys etc.). */
  settings?: Record<string, unknown>;
  checks: Check[];
  /** What a vision judge should look for in the rendered frame. */
  judgeRubric?: string;
};

export type CheckResult = {
  check: Check;
  passed: boolean;
  detail: string;
};

export type RenderSummary = {
  rendered: boolean;
  renderMs: number | null;
  errors: string[];
  /** Runtime log lines (capped), for diagnosing silent failures. */
  logs: string[];
  pixelStats: PixelStats | null;
  pngPath: string | null;
};

export type JudgeVerdict = {
  score: number;
  verdict: string;
  problems: string[];
};

export type TurnRecord = {
  role: "user" | "assistant";
  content: string;
  tool?: string;
  rounds?: number;
  toolCalls?: string[];
  usage?: ResponseUsage;
  ms?: number;
};

export type EvalResult = {
  id: string;
  tags: string[];
  prompt: string;
  seedSlug: string | null;
  frame: FrameSize;
  model: string;
  reasoningEffort: string;
  startedAt: string;
  durationMs: number;
  turns: TurnRecord[];
  /** Tool the FIRST agent turn reported (build_scene / modify_scene / reply). */
  deliveredTool: string;
  deliveredScenes: unknown[] | null;
  /** How many tool calls bounced with lint/validation issues before delivery. */
  deliveryBounces: number;
  renderCheckRounds: number;
  lint: { errors: LintIssue[]; warnings: LintIssue[] } | null;
  render: RenderSummary | null;
  judge: JudgeVerdict | null;
  checks: CheckResult[];
  passed: boolean;
  usage: ResponseUsage;
  error: string | null;
};

export type EvalRun = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  model: string;
  reasoningEffort: string;
  cloudUrl: string;
  options: Record<string, unknown>;
  results: EvalResult[];
  summary: EvalSummary;
};

export type EvalSummary = {
  cases: number;
  passed: number;
  checkPassRate: number;
  deliveredRate: number;
  lintCleanRate: number;
  renderOkRate: number;
  judgeMean: number | null;
  meanBounces: number;
  meanRounds: number;
  meanDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byTag: Record<string, { cases: number; passed: number }>;
};
