// Browser client for POST /api/ai/chat (NDJSON, one event per line). Used by
// the scene store's AI panel; kept free of Next server imports so it can run
// in the browser and under vitest's node environment alike.

export type AiScenesTool = "build_scene" | "modify_scene";

export type AiChatEvent =
  | { type: "chat"; chatId: string }
  | { type: "delta"; text: string }
  | {
      type: "tool";
      name: string;
      label: string;
      status: "start" | "done" | "error";
      detail?: string | undefined;
    }
  | {
      type: "scenes";
      tool: AiScenesTool;
      title?: string | undefined;
      scenes: Record<string, unknown>[];
    }
  | { type: "done"; tool: string; reply: string }
  | { type: "error"; detail: string };

export type AiChatHistoryItem = { role: "user" | "assistant"; content: string };

export type AiChatRequest = {
  prompt: string;
  /** Client-minted uuid; reuse it across the turns of one conversation. */
  chatId?: string | undefined;
  /** The store scene being viewed/edited, if any. */
  storeSceneId?: string | undefined;
  /** Which UI the chat runs in, so the model can name the right save button. */
  surface?: "store" | "store-new" | undefined;
  /** The scene in the editor the AI should modify. */
  sceneId?: string | undefined;
  /** That scene's latest JSON from the editor. */
  scene?: Record<string, unknown> | undefined;
  /** Every scene in the editor, for multi-scene context. */
  scenes?: Record<string, unknown>[] | undefined;
  history?: AiChatHistoryItem[] | undefined;
};

// A non-2xx answer before the stream started: `code` is the server's
// `error` string (login_required, missing_api_key, rate_limited, ...).
export class AiChatRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, detail?: string) {
    super(detail || code);
    this.name = "AiChatRequestError";
    this.code = code;
    this.status = status;
  }
}

const eventTypes = new Set(["chat", "delta", "tool", "scenes", "done", "error"]);

/** One NDJSON line → event, or null for blank/garbled lines. */
export function parseAiChatLine(line: string): AiChatEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    typeof (parsed as { type?: unknown }).type === "string" &&
    eventTypes.has((parsed as { type: string }).type)
  ) {
    return parsed as AiChatEvent;
  }
  return null;
}

/**
 * Streams one chat turn. Resolves when the server closes the stream; every
 * event is handed to `onEvent` in order (awaited, so handlers may be async).
 * Throws AiChatRequestError for a pre-stream error status, and rethrows the
 * abort error when `signal` fires.
 */
export async function streamAiChat(
  body: AiChatRequest,
  {
    signal,
    onEvent,
    endpoint = "/api/ai/chat",
  }: {
    signal?: AbortSignal | undefined;
    onEvent: (event: AiChatEvent) => void | Promise<void>;
    endpoint?: string;
  },
): Promise<void> {
  const response = await fetch(endpoint, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      detail?: unknown;
    };
    const code =
      typeof payload.error === "string" && payload.error
        ? payload.error
        : response.status === 429
          ? "rate_limited"
          : `http_${response.status}`;
    throw new AiChatRequestError(
      code,
      response.status,
      typeof payload.detail === "string" ? payload.detail : undefined,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleLine = async (line: string) => {
    const event = parseAiChatLine(line);
    if (event) {
      await onEvent(event);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      await handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  await handleLine(buffer);
}
