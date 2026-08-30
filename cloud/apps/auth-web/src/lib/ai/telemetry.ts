// PostHog LLM-analytics events for the AI chat. Until this existed the v2
// chat was invisible: the only $ai_generation rows in the project came from
// the retired Python backend, and a turn that died mid-stream left no trace
// anywhere. Now every model round emits a $ai_generation and every turn a
// summary, both keyed by the turn id as $ai_trace_id so a report ("it said
// network error") can be matched to what the server actually saw.
//
// Privacy: no prompts, no completions, no scene JSON — only counts, timings,
// model names, tool names and outcomes. Posting is fire-and-forget through
// the public project key, exactly like error-tracking.ts.

import { posthogConfig } from "../error-tracking";
import type { ResponseUsage } from "./openai";

const captureTimeoutMs = 5000;
const libName = "frameos-cloud-auth-web";

type Properties = Record<string, unknown>;

async function capture(distinctId: string, event: string, properties: Properties) {
  const config = posthogConfig();
  if (!config) {
    return;
  }
  try {
    await fetch(`${config.host}/capture/`, {
      body: JSON.stringify({
        api_key: config.apiKey,
        distinct_id: distinctId,
        event,
        properties: { $lib: libName, ...properties },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(captureTimeoutMs),
    });
  } catch {
    // Telemetry never gets to break a chat turn.
  }
}

export type AiGenerationRecord = {
  accountId: string;
  turnId: string;
  chatId: string;
  round: number;
  model: string;
  reasoningEffort: string;
  latencyMs: number;
  usage?: ResponseUsage | undefined;
  // OpenAI's response status ("completed", "incomplete") or our failure.
  status: string;
  httpStatus?: number | undefined;
  error?: string | undefined;
  toolCalls: string[];
};

// One model round-trip. Property names follow PostHog's LLM observability
// schema so the rows show up in its traces UI.
export function captureAiGeneration(record: AiGenerationRecord) {
  const usage = record.usage;
  void capture(record.accountId, "$ai_generation", {
    $ai_base_url: "https://api.openai.com/v1",
    $ai_cache_read_input_tokens: usage?.cachedInputTokens ?? 0,
    $ai_error: record.error ?? null,
    $ai_http_status: record.httpStatus ?? (record.error ? 0 : 200),
    $ai_input_tokens: usage?.inputTokens ?? 0,
    $ai_is_error: Boolean(record.error),
    $ai_latency: record.latencyMs / 1000,
    $ai_model: record.model,
    $ai_output_tokens: usage?.outputTokens ?? 0,
    $ai_provider: "openai",
    $ai_reasoning_tokens: usage?.reasoningTokens ?? 0,
    $ai_span_id: `${record.turnId}:${record.round}`,
    $ai_span_name: `chat round ${record.round}`,
    $ai_trace_id: record.turnId,
    frameos_chat_id: record.chatId,
    frameos_reasoning_effort: record.reasoningEffort,
    frameos_round: record.round,
    frameos_status: record.status,
    frameos_tool_calls: record.toolCalls,
  });
}

export type AiTurnRecord = {
  accountId: string;
  turnId: string;
  chatId: string;
  surface: string;
  model: string;
  outcome: "ok" | "error" | "stopped" | "timeout";
  error?: string | undefined;
  durationMs: number;
  rounds: number;
  toolCalls: string[];
  deliveredTool: string;
  usage: ResponseUsage;
  // How often the browser's stream dropped and how often it came back.
  disconnects: number;
  resumes: number;
};

// One chat turn end to end. `outcome` is what the user experienced: "ok" is
// a reply, "error" a failure surfaced to them, "stopped" their own Stop
// button, "timeout" the turn ceiling.
export function captureAiTurn(record: AiTurnRecord) {
  void capture(record.accountId, "ai_chat_turn", {
    $ai_trace_id: record.turnId,
    delivered_tool: record.deliveredTool,
    disconnects: record.disconnects,
    duration_ms: record.durationMs,
    error: record.error ?? null,
    input_tokens: record.usage.inputTokens,
    model: record.model,
    outcome: record.outcome,
    output_tokens: record.usage.outputTokens,
    reasoning_tokens: record.usage.reasoningTokens,
    resumes: record.resumes,
    rounds: record.rounds,
    surface: record.surface,
    tool_calls: record.toolCalls,
    turn_id: record.turnId,
  });
}

export type SceneConversionRecord = {
  /** The account, or "anonymous" — the converter needs no sign-in. */
  distinctId: string;
  requestId: string;
  scenes: number;
  modelCalls: number;
  model?: string | undefined;
  keySource: "request" | "account" | "shared" | "none";
  codeNodesDeterministic: number;
  codeNodesModel: number;
  apps: number;
  needsModel: number;
  needsManualPort: number;
  lintErrors: number;
  renderErrors: number | null;
  durationMs: number;
  usage?: ResponseUsage | { inputTokens: number; outputTokens: number; reasoningTokens: number } | undefined;
  error?: string | undefined;
};

// One POST /api/scenes/convert, end to end: how much pass 1 got, how much
// the model got, what was left, and whether the result lints and renders.
// The number of conversions that leave something behind is the measure of
// the converter; no scene content is sent.
export function captureSceneConversion(record: SceneConversionRecord) {
  void capture(record.distinctId, "scene_convert", {
    $ai_input_tokens: record.usage?.inputTokens ?? 0,
    $ai_model: record.model ?? null,
    $ai_output_tokens: record.usage?.outputTokens ?? 0,
    $ai_trace_id: record.requestId,
    apps: record.apps,
    code_nodes_deterministic: record.codeNodesDeterministic,
    code_nodes_model: record.codeNodesModel,
    duration_ms: record.durationMs,
    error: record.error ?? null,
    key_source: record.keySource,
    lint_errors: record.lintErrors,
    model_calls: record.modelCalls,
    needs_manual_port: record.needsManualPort,
    needs_model: record.needsModel,
    render_errors: record.renderErrors,
    scenes: record.scenes,
  });
}
