// Minimal streaming client for the OpenAI Responses API. Raw fetch + SSE
// parsing, no SDK — consistent with the rest of the codebase (the old chat
// used raw fetch against /v1/chat/completions).
//
// The conversation is managed statelessly (store: false): every request sends
// the full input item list, and reasoning items round-trip via
// encrypted_content, so nothing about the user's chat is retained by OpenAI
// beyond the request.

export type ResponseInputItem = Record<string, unknown>;

export type FunctionCallItem = {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
};

export type ResponsesToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
};

export type ResponseUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export type StreamedResponse = {
  output: ResponseInputItem[];
  outputText: string;
  functionCalls: FunctionCallItem[];
  status: string;
  usage: ResponseUsage;
};

export function emptyUsage(): ResponseUsage {
  return { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

export function addUsage(total: ResponseUsage, part: ResponseUsage): ResponseUsage {
  return {
    cachedInputTokens: total.cachedInputTokens + part.cachedInputTokens,
    inputTokens: total.inputTokens + part.inputTokens,
    outputTokens: total.outputTokens + part.outputTokens,
    reasoningTokens: total.reasoningTokens + part.reasoningTokens,
  };
}

function usageFrom(raw: unknown): ResponseUsage {
  const usage = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  return {
    cachedInputTokens: num(inputDetails?.cached_tokens),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    reasoningTokens: num(outputDetails?.reasoning_tokens),
  };
}

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
// Per-call budget. The whole route runs under maxDuration below OpenAI's own
// per-request ceiling; a single stalled call must not eat the entire budget.
export const OPENAI_CALL_TIMEOUT_MS = 240 * 1000;

export const DEFAULT_CHAT_MODEL = "gpt-5.5";
export const DEFAULT_REASONING_EFFORT = "low";
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

export function resolveChatModel(settings: Record<string, unknown>): string {
  const configured = settings.chatModel ?? settings.model;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  return DEFAULT_CHAT_MODEL;
}

export function resolveReasoningEffort(
  settings: Record<string, unknown>,
): string {
  const configured = settings.chatReasoningEffort;
  if (typeof configured === "string" && REASONING_EFFORTS.has(configured.trim())) {
    return configured.trim();
  }
  return DEFAULT_REASONING_EFFORT;
}

// gpt-5 family and o-series accept the reasoning parameter; anything else
// (gpt-4.1, custom deployments) must not receive it.
export function modelSupportsReasoning(model: string): boolean {
  return /^(gpt-5|o[0-9])/.test(model);
}

function parseSseChunks(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let working = buffer;
  let index: number;
  while ((index = working.indexOf("\n\n")) !== -1) {
    events.push(working.slice(0, index));
    working = working.slice(index + 2);
  }
  return { events, rest: working };
}

function dataPayload(rawEvent: string): unknown | undefined {
  const dataLines = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) {
    return undefined;
  }
  const joined = dataLines.join("\n");
  if (joined === "[DONE]") {
    return undefined;
  }
  try {
    return JSON.parse(joined);
  } catch {
    return undefined;
  }
}

export async function streamResponse({
  apiKey,
  model,
  instructions,
  input,
  tools,
  reasoningEffort,
  onTextDelta,
  signal,
}: {
  apiKey: string;
  model: string;
  instructions: string;
  input: ResponseInputItem[];
  tools: ResponsesToolDefinition[];
  reasoningEffort?: string;
  onTextDelta: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<StreamedResponse> {
  const useReasoning = modelSupportsReasoning(model);
  const body: Record<string, unknown> = {
    input,
    instructions,
    model,
    store: false,
    stream: true,
    tools,
  };
  if (useReasoning) {
    body.reasoning = { effort: reasoningEffort ?? DEFAULT_REASONING_EFFORT };
    // Required for store:false multi-step tool loops: reasoning items must
    // round-trip between calls or the model loses its chain of thought.
    body.include = ["reasoning.encrypted_content"];
  }

  const timeoutSignal = AbortSignal.timeout(OPENAI_CALL_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(OPENAI_RESPONSES_URL, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: combinedSignal,
  });

  if (!response.ok || !response.body) {
    let detail = `OpenAI request failed with status ${response.status}`;
    try {
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      if (payload?.error?.message) {
        detail = payload.error.message;
      }
    } catch {
      // keep the status-based message
    }
    if (response.status === 404) {
      detail = `Model "${model}" was not found by OpenAI. Check the model name in Settings -> OpenAI.`;
    }
    throw new Error(detail);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: StreamedResponse | undefined;
  let failure: string | undefined;
  let outputText = "";

  const handleEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const event = payload as Record<string, unknown>;
    const type = event.type;
    if (type === "response.output_text.delta") {
      const delta = event.delta;
      if (typeof delta === "string" && delta) {
        outputText += delta;
        onTextDelta(delta);
      }
      return;
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const responsePayload = event.response as
        | { output?: unknown[]; status?: string; usage?: unknown }
        | undefined;
      const output = Array.isArray(responsePayload?.output)
        ? (responsePayload.output as ResponseInputItem[])
        : [];
      completed = {
        functionCalls: output.filter(
          (item): item is FunctionCallItem =>
            (item as { type?: unknown }).type === "function_call",
        ),
        output,
        outputText,
        status:
          typeof responsePayload?.status === "string"
            ? responsePayload.status
            : "completed",
        usage: usageFrom(responsePayload?.usage),
      };
      return;
    }
    if (type === "response.failed") {
      const responsePayload = event.response as
        | { error?: { message?: string } }
        | undefined;
      failure = responsePayload?.error?.message ?? "OpenAI response failed";
      return;
    }
    if (type === "error") {
      const message = event.message;
      failure = typeof message === "string" ? message : "OpenAI stream error";
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseChunks(buffer);
    buffer = rest;
    for (const rawEvent of events) {
      handleEvent(dataPayload(rawEvent));
    }
  }
  // Flush a possibly complete trailing event without a final blank line.
  if (buffer.trim()) {
    handleEvent(dataPayload(buffer));
  }

  if (failure) {
    throw new Error(failure);
  }
  if (!completed) {
    throw new Error("OpenAI stream ended without a completed response");
  }
  return completed;
}
