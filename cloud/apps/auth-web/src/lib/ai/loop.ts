// The agent loop: one streaming OpenAI Responses call at a time, executing
// tool calls between rounds, forwarding text deltas and tool activity to the
// client as they happen. This replaces the old router → plan → generate →
// review → repair pipeline (4-6 sequential blocking calls) with a single
// visible-progress loop.
import {
  addUsage,
  emptyUsage,
  streamResponse,
  type FunctionCallItem,
  type ResponseInputItem,
  type ResponseUsage,
} from "./openai";
import { buildSystemPrompt } from "./prompts";
import {
  executeTool,
  toolDefinitions,
  toolLabels,
  type ScenesEvent,
  type ToolContext,
} from "./tools";
import type { JsonObject } from "./scene-utils";

export type ChatStreamEvent =
  | { type: "chat"; chatId: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; label: string; status: "start" | "done" | "error"; detail?: string }
  | ScenesEvent
  | { type: "done"; tool: string; reply: string }
  | { type: "error"; detail: string };

export const MAX_TOOL_ROUNDS = 12;

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

function parseToolArguments(call: FunctionCallItem): JsonObject {
  try {
    const parsed = JSON.parse(call.arguments) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    // fall through
  }
  return {};
}

export async function runAgentLoop({
  apiKey,
  model,
  reasoningEffort,
  input,
  toolContext,
  emit,
  signal,
}: {
  apiKey: string;
  model: string;
  reasoningEffort: string;
  input: ResponseInputItem[];
  toolContext: ToolContext;
  emit: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}): Promise<AgentLoopResult> {
  const instructions = buildSystemPrompt();
  let reply = "";
  let usage: ResponseUsage = emptyUsage();
  let rounds = 0;
  const toolCalls: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    rounds += 1;
    const response = await streamResponse({
      apiKey,
      input,
      instructions,
      model,
      onTextDelta: (delta) => {
        reply += delta;
        emit({ text: delta, type: "delta" });
      },
      reasoningEffort,
      ...(signal ? { signal } : {}),
      tools: toolDefinitions,
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
      try {
        output = await executeTool(call.name, parseToolArguments(call), toolContext);
        emit({ label, name: call.name, status: "done", type: "tool" });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        output = JSON.stringify({ error: detail });
        emit({ detail, label, name: call.name, status: "error", type: "tool" });
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
