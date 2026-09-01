// The agent loop: one streaming OpenAI Responses call at a time, executing
// tool calls between rounds, forwarding text deltas and tool activity to the
// client as they happen. This replaces the old router → plan → generate →
// review → repair pipeline (4-6 sequential blocking calls) with a single
// visible-progress loop.
import {
  addUsage,
  emptyUsage,
  OpenAiRequestError,
  streamResponse,
  type ResponseInputItem,
  type ResponseUsage,
} from "./openai";
import { buildSystemPrompt } from "./prompts";
import {
  executeTool,
  toolDefinitions,
  toolLabels,
  type ListingEvent,
  type ScenesEvent,
  type ToolContext,
} from "./tools";
import { parseToolArguments } from "./tool-args";

export type ChatStreamEvent =
  // turnId identifies the detached server-side turn; the client resumes the
  // stream with it after a dropped connection (see turn-runner.ts).
  | { type: "chat"; chatId: string; turnId?: string }
  | { type: "delta"; text: string }
  // "progress" = the model is still writing this call's arguments (bytes so
  // far); "start" = it is executing; "done"/"error" = it finished.
  | {
      type: "tool";
      name: string;
      label: string;
      status: "progress" | "start" | "done" | "error";
      detail?: string;
    }
  | ScenesEvent
  | ListingEvent
  | { type: "done"; tool: string; reply: string }
  | { type: "error"; detail: string }
  // Keepalive from the relay while nothing else is flowing; never buffered,
  // never counted, ignored by clients.
  | { type: "ping" };

export const MAX_TOOL_ROUNDS = 12;

// What one model round looked like, for telemetry. Reported after every
// streamResponse call, failed ones included (then `error` is set and usage
// is absent).
export type RoundReport = {
  round: number;
  latencyMs: number;
  usage?: ResponseUsage;
  status: string;
  httpStatus?: number;
  error?: string;
  toolCalls: string[];
};

// A function call whose arguments never parsed as JSON, so the tool did not
// run. Reported separately from RoundReport because it is only discovered
// after that round's telemetry has already gone out.
export type ToolArgumentErrorReport = {
  round: number;
  tool: string;
  // The JSON.parse failure (a position, never scene content).
  detail: string;
  length: number;
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

export type AgentLoopResult = {
  reply: string;
  tool: string;
  // Diagnostics for evals and logs: model round-trips, the tool names called
  // in order, and summed token usage across the loop.
  rounds: number;
  toolCalls: string[];
  usage: ResponseUsage;
};

function userMessage(text: string): ResponseInputItem {
  return { content: [{ text, type: "input_text" }], role: "user" };
}

function assistantMessage(text: string): ResponseInputItem {
  return { content: [{ text, type: "output_text" }], role: "assistant" };
}

export function buildInitialInput({
  contextBlock,
  history,
  prompt,
}: {
  contextBlock: string;
  history: { role: "user" | "assistant"; content: string }[];
  prompt: string;
}): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  if (contextBlock.trim()) {
    input.push(userMessage(`Context for this conversation:\n\n${contextBlock.trim()}`));
  }
  for (const item of history) {
    input.push(item.role === "user" ? userMessage(item.content) : assistantMessage(item.content));
  }
  input.push(userMessage(prompt));
  return input;
}

export async function runAgentLoop({
  apiKey,
  model,
  reasoningEffort,
  input,
  toolContext,
  emit,
  signal,
  onRound,
  onToolArgumentError,
}: {
  apiKey: string;
  model: string;
  reasoningEffort: string;
  input: ResponseInputItem[];
  toolContext: ToolContext;
  emit: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
  onRound?: (report: RoundReport) => void;
  onToolArgumentError?: (report: ToolArgumentErrorReport) => void;
}): Promise<AgentLoopResult> {
  const instructions = buildSystemPrompt();
  let reply = "";
  let usage: ResponseUsage = emptyUsage();
  let rounds = 0;
  const toolCalls: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    rounds += 1;
    const startedAt = Date.now();
    // Progress lines are throttled per call: one per ~4 KB of arguments, so
    // a 70 KB scene shows a steadily rising number instead of a firehose.
    const progressReported = new Map<string, number>();
    let response;
    try {
      response = await streamResponse({
        apiKey,
        input,
        instructions,
        model,
        onFunctionCallProgress: ({ bytes, name }) => {
          const last = progressReported.get(name) ?? -1;
          if (bytes !== 0 && bytes - last < 4096) {
            return;
          }
          progressReported.set(name, bytes);
          emit({
            detail: bytes === 0 ? "writing…" : `${formatBytes(bytes)} written`,
            label: toolLabels[name] ?? name,
            name,
            status: "progress",
            type: "tool",
          });
        },
        onTextDelta: (delta) => {
          reply += delta;
          emit({ text: delta, type: "delta" });
        },
        reasoningEffort,
        ...(signal ? { signal } : {}),
        tools: toolDefinitions,
      });
    } catch (error) {
      onRound?.({
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof OpenAiRequestError ? { httpStatus: error.status } : {}),
        latencyMs: Date.now() - startedAt,
        round: rounds,
        status: "failed",
        toolCalls: [],
      });
      throw error;
    }
    onRound?.({
      latencyMs: Date.now() - startedAt,
      round: rounds,
      status: response.status,
      toolCalls: response.functionCalls.map((call) => call.name),
      usage: response.usage,
    });

    usage = addUsage(usage, response.usage);
    if (response.functionCalls.length === 0) {
      return { reply, rounds, tool: toolContext.deliveredTool ?? "reply", toolCalls, usage };
    }

    // Feed the model's own output items back (reasoning + text + calls), then
    // each call's result.
    input.push(...response.output);
    for (const call of response.functionCalls) {
      const label = toolLabels[call.name] ?? call.name;
      toolCalls.push(call.name);
      emit({ label, name: call.name, status: "start", type: "tool" });
      let output: string;
      const parsed = parseToolArguments(call.name, call.arguments);
      if ("error" in parsed) {
        // The call never ran. Hand the model a result that says exactly that,
        // so it re-sends instead of reporting that the tool rejected work it
        // never saw.
        output = JSON.stringify({ error: parsed.error, ok: false });
        onToolArgumentError?.({
          detail: parsed.detail,
          length: parsed.length,
          round: rounds,
          tool: call.name,
        });
        emit({
          detail: "arguments were not valid JSON",
          label,
          name: call.name,
          status: "error",
          type: "tool",
        });
      } else {
        try {
          output = await executeTool(call.name, parsed.args, toolContext);
          emit({ label, name: call.name, status: "done", type: "tool" });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          output = JSON.stringify({ error: detail });
          emit({ detail, label, name: call.name, status: "error", type: "tool" });
        }
      }
      input.push({
        call_id: call.call_id,
        output,
        type: "function_call_output",
      });
    }
  }

  // Ran out of rounds mid-tool-use: surface what we have.
  if (!reply.trim()) {
    reply =
      "I ran out of steps while working on this. The partial work above may be incomplete — please try again with a narrower request.";
    emit({ text: reply, type: "delta" });
  }
  return { reply, rounds, tool: toolContext.deliveredTool ?? "reply", toolCalls, usage };
}
