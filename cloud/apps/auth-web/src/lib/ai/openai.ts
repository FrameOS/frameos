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

// Progress of a function call the model is still writing: how many bytes of
// its JSON arguments have arrived so far. A whole-scene update_scene is tens
// of kilobytes that stream for minutes with no visible text, so this is the
// only sign of life the client gets while it happens.
export type FunctionCallProgress = { name: string; bytes: number };

// A non-2xx answer from OpenAI, with the status for telemetry.
export class OpenAiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenAiRequestError";
    this.status = status;
  }
}

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
// Idle budget: abort when OpenAI sends nothing for this long. Deliberately
// an idle timeout rather than a per-call ceiling — a legitimate call that
// streams a 70 KB scene for five minutes keeps producing bytes throughout,
// while a stalled connection produces none. (The old 240 s total budget cut
// off exactly those long-but-healthy generations.) A whole-turn ceiling
// lives in the turn runner.
export const OPENAI_IDLE_TIMEOUT_MS = 120 * 1000;

// gpt-5.6-terra: matched gpt-5.5's eval pass rate with better judge scores at
// ~40% of the price (evals/compare-models.ts run 2026-08-30, 9 cases × 4 models).
export const DEFAULT_CHAT_MODEL = "gpt-5.6-terra";
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
  onFunctionCallProgress,
  signal,
  idleTimeoutMs = OPENAI_IDLE_TIMEOUT_MS,
}: {
  apiKey: string;
  model: string;
  instructions: string;
  input: ResponseInputItem[];
  tools: ResponsesToolDefinition[];
  reasoningEffort?: string;
  onTextDelta: (delta: string) => void;
  onFunctionCallProgress?: (progress: FunctionCallProgress) => void;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
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

  // Idle watchdog: re-armed on every chunk OpenAI sends (headers included).
  const idle = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idle.abort(
        new Error(
          `OpenAI sent nothing for ${Math.round(idleTimeoutMs / 1000)}s; the connection was dropped.`,
        ),
      );
    }, idleTimeoutMs);
  };
  const combinedSignal = signal
    ? AbortSignal.any([signal, idle.signal])
    : idle.signal;
  // Whatever undici throws on abort ("This operation was aborted"), surface
  // the reason we (or the caller) attached — it says what actually happened.
  const abortReason = (error: unknown): unknown => {
    if (idle.signal.aborted) {
      return idle.signal.reason;
    }
    if (signal?.aborted) {
      return signal.reason instanceof Error ? signal.reason : new Error("The request was stopped.");
    }
    return error;
  };

  armIdle();
  let response: Response;
  try {
    response = await fetch(OPENAI_RESPONSES_URL, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: combinedSignal,
    });
  } catch (error) {
    clearTimeout(idleTimer);
    throw abortReason(error);
  }
  armIdle();

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
    clearTimeout(idleTimer);
    throw new OpenAiRequestError(detail, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: StreamedResponse | undefined;
  let failure: string | undefined;
  let outputText = "";
  // Function calls in flight, by output item id, with the argument bytes seen.
  const callsInProgress = new Map<string, FunctionCallProgress>();

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
    if (type === "response.output_item.added") {
      const item = event.item as { type?: unknown; id?: unknown; name?: unknown } | undefined;
      if (
        item?.type === "function_call" &&
        typeof item.id === "string" &&
        typeof item.name === "string"
      ) {
        const progress = { bytes: 0, name: item.name };
        callsInProgress.set(item.id, progress);
        onFunctionCallProgress?.({ ...progress });
      }
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      const progress =
        typeof event.item_id === "string" ? callsInProgress.get(event.item_id) : undefined;
      if (progress && typeof event.delta === "string") {
        progress.bytes += event.delta.length;
        onFunctionCallProgress?.({ ...progress });
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

  // Not every fetch implementation errors the body stream when the signal
  // aborts (undici does; mocks and some polyfills do not), so race each read
  // against the signal ourselves.
  const aborted = new Promise<never>((_resolve, reject) => {
    if (combinedSignal.aborted) {
      reject(combinedSignal.reason);
      return;
    }
    combinedSignal.addEventListener("abort", () => reject(combinedSignal.reason), { once: true });
  });
  aborted.catch(() => {
    // observed through Promise.race below; this only silences the unhandled-rejection warning
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) {
        break;
      }
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunks(buffer);
      buffer = rest;
      for (const rawEvent of events) {
        handleEvent(dataPayload(rawEvent));
      }
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw abortReason(error);
  } finally {
    clearTimeout(idleTimer);
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
