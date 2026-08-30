// The one model call shape the converter makes: instructions + one user
// message + one tool the model MUST call. The converter never talks to
// OpenAI itself — it takes a ModelPort, so tests pass a fake and the cloud
// or the CLI pass openAiModelPort(). Non-streaming on purpose: a port is one
// request, one JSON result, nothing to resume.

import type { ModelUsage } from "./types";

export type ModelTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ModelRequest = {
  instructions: string;
  input: string;
  tool: ModelTool;
};

export type ModelResult = {
  /** Parsed arguments of the tool call, or undefined when the model made none. */
  arguments: unknown;
  /** Any prose the model produced instead of / next to the call. */
  text: string;
  usage: ModelUsage;
  model: string;
};

export type ModelPort = (request: ModelRequest, signal?: AbortSignal) => Promise<ModelResult>;

export const DEFAULT_CONVERT_MODEL = "gpt-5.5";
export const DEFAULT_CONVERT_REASONING_EFFORT = "medium";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const defaultTimeoutMs = 240_000;

export class ModelRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ModelRequestError";
    this.status = status;
  }
}

// gpt-5 family and o-series accept the reasoning parameter; anything else
// must not receive it (mirrors modelSupportsReasoning in the cloud app).
function supportsReasoning(model: string): boolean {
  return /^(gpt-5|o[0-9])/.test(model);
}

export function openAiModelPort(options: {
  apiKey: string;
  model?: string | undefined;
  reasoningEffort?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  baseUrl?: string | undefined;
}): ModelPort {
  const model = options.model?.trim() || DEFAULT_CONVERT_MODEL;
  const doFetch = options.fetchImpl ?? fetch;
  const url = options.baseUrl ?? OPENAI_RESPONSES_URL;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  return async (request, signal) => {
    const body: Record<string, unknown> = {
      input: [{ content: request.input, role: "user", type: "message" }],
      instructions: request.instructions,
      model,
      store: false,
      tool_choice: { name: request.tool.name, type: "function" },
      tools: [
        {
          description: request.tool.description,
          name: request.tool.name,
          parameters: request.tool.parameters,
          strict: false,
          type: "function",
        },
      ],
    };
    if (supportsReasoning(model)) {
      body.reasoning = { effort: options.reasoningEffort ?? DEFAULT_CONVERT_REASONING_EFFORT };
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await doFetch(url, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        detail = parsed.error?.message ?? detail;
      } catch {
        // keep the raw text
      }
      throw new ModelRequestError(`OpenAI answered ${response.status}: ${detail}`, response.status);
    }
    const payload = (await response.json()) as {
      model?: string;
      output?: { type?: string; name?: string; arguments?: string; content?: { type?: string; text?: string }[] }[];
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        output_tokens_details?: { reasoning_tokens?: number };
      };
    };
    let args: unknown;
    let text = "";
    for (const item of payload.output ?? []) {
      if (item.type === "function_call" && item.name === request.tool.name && typeof item.arguments === "string") {
        try {
          args = JSON.parse(item.arguments);
        } catch {
          args = undefined;
        }
      } else if (item.type === "message") {
        for (const part of item.content ?? []) {
          if (part.type === "output_text" && typeof part.text === "string") {
            text += part.text;
          }
        }
      }
    }
    const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    return {
      arguments: args,
      model: payload.model ?? model,
      text,
      usage: {
        inputTokens: num(payload.usage?.input_tokens),
        outputTokens: num(payload.usage?.output_tokens),
        reasoningTokens: num(payload.usage?.output_tokens_details?.reasoning_tokens),
      },
    };
  };
}
