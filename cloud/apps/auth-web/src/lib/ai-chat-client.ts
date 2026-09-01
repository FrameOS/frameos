// Browser client for POST /api/ai/chat (NDJSON, one event per line). Used by
// the scene store's AI panel; kept free of Next server imports so it can run
// in the browser and under vitest's node environment alike.
//
// Turns run detached on the server (see ai/turn-runner.ts). If the response
// stream drops mid-turn — a proxy idle cut, a flaky link — this client
// reopens it at GET /api/ai/chat/turns/<turnId>?after=<events seen> and the
// caller never notices beyond a short pause. Only when that fails repeatedly,
// or the turn is gone, does it throw an AiChatTransportError.

export type AiScenesTool = "build_scene" | "modify_scene";

export type AiChatEvent =
  | { type: "chat"; chatId: string; turnId?: string | undefined }
  | { type: "delta"; text: string }
  | {
      type: "tool";
      name: string;
      label: string;
      status: "progress" | "start" | "done" | "error";
      detail?: string | undefined;
    }
  | {
      type: "scenes";
      tool: AiScenesTool;
      title?: string | undefined;
      scenes: Record<string, unknown>[];
    }
  | {
      /** A listing edit for the draft (description, tags, category, minimum
       * FrameOS version): applied like scenes, published by Save. */
      type: "listing";
      listing: AiListingChanges;
    }
  | { type: "done"; tool: string; reply: string }
  | { type: "error"; detail: string }
  | { type: "ping" };

export type AiListingChanges = {
  category?: string | null | undefined;
  description?: string | null | undefined;
  frameosVersion?: string | null | undefined;
  tags?: string[] | undefined;
};

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
  /** The draft's listing as the editor holds it (unsaved edits included),
   * so the assistant edits what the user sees, not what was published. */
  listing?: AiListingChanges | undefined;
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

// The stream was lost mid-turn and could not be resumed. `elapsedMs` is how
// long the turn had been running; `turnId` is set when the server-side turn
// existed (so the reply may still land in the chat history).
export class AiChatTransportError extends Error {
  readonly elapsedMs: number;
  readonly turnId: string | undefined;
  readonly attempts: number;

  constructor(input: { elapsedMs: number; turnId?: string | undefined; attempts: number; cause?: unknown }) {
    super(transportFailureMessage(input.elapsedMs, Boolean(input.turnId)));
    this.name = "AiChatTransportError";
    this.elapsedMs = input.elapsedMs;
    this.turnId = input.turnId;
    this.attempts = input.attempts;
    if (input.cause !== undefined) {
      (this as { cause?: unknown }).cause = input.cause;
    }
  }
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

// What the user reads instead of the browser's bare "network error".
export function transportFailureMessage(elapsedMs: number, hadTurn: boolean): string {
  const base = `Connection to the assistant dropped after ${formatElapsed(elapsedMs)}`;
  if (!hadTurn) {
    return `${base}, before it started working. Check your connection and try again.`;
  }
  return `${base} and could not be re-established. The assistant may still finish on its own — reload this chat in a minute to see its reply.`;
}

const eventTypes = new Set(["chat", "delta", "tool", "scenes", "listing", "done", "error", "ping"]);

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

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === "AbortError");
}

async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      await onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  await onLine(buffer);
}

export const DEFAULT_RESUME_ATTEMPTS = 5;
// Backoff between resume attempts (ms), capped at the last entry.
const resumeDelaysMs = [500, 1500, 3000, 5000, 8000];

export type StreamAiChatOptions = {
  signal?: AbortSignal | undefined;
  onEvent: (event: AiChatEvent) => void | Promise<void>;
  endpoint?: string;
  resumeEndpoint?: string;
  resumeAttempts?: number;
  /** Called when the stream dropped and a resume is about to be tried. */
  onResume?: ((info: { attempt: number; elapsedMs: number }) => void) | undefined;
  /** Test hook: replaces the backoff sleep. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Streams one chat turn. Resolves when the turn is over (a done or error
 * event arrived and the server closed the stream); every event is handed to
 * `onEvent` in order (awaited, so handlers may be async). Throws
 * AiChatRequestError for a pre-stream error status, AiChatTransportError
 * when the stream was lost and could not be resumed, and rethrows the abort
 * error when `signal` fires.
 */
export async function streamAiChat(
  body: AiChatRequest,
  {
    signal,
    onEvent,
    endpoint = "/api/ai/chat",
    resumeEndpoint = "/api/ai/chat/turns",
    resumeAttempts = DEFAULT_RESUME_ATTEMPTS,
    onResume,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: StreamAiChatOptions,
): Promise<void> {
  const startedAt = Date.now();
  let turnId: string | undefined;
  // Events delivered so far (pings excluded) — the resume offset.
  let received = 0;
  let finished = false;

  const handleLine = async (line: string) => {
    const event = parseAiChatLine(line);
    if (!event || event.type === "ping") {
      return;
    }
    if (event.type === "chat" && event.turnId) {
      turnId = event.turnId;
    }
    if (event.type === "done" || event.type === "error") {
      finished = true;
    }
    received += 1;
    await onEvent(event);
  };

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

  let lastFailure: unknown;
  try {
    await readNdjson(response.body, handleLine);
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    lastFailure = error;
  }
  if (finished) {
    return;
  }
  // The stream ended without a terminal event: cut by something in between.
  if (!turnId) {
    throw new AiChatTransportError({ attempts: 0, cause: lastFailure, elapsedMs: Date.now() - startedAt });
  }

  for (let attempt = 1; attempt <= resumeAttempts; attempt += 1) {
    if (signal?.aborted) {
      throw lastFailure instanceof Error && lastFailure.name === "AbortError"
        ? lastFailure
        : new DOMException("The turn was stopped.", "AbortError");
    }
    onResume?.({ attempt, elapsedMs: Date.now() - startedAt });
    await sleep(resumeDelaysMs[Math.min(attempt, resumeDelaysMs.length) - 1]!);
    let resumed: Response;
    try {
      resumed = await fetch(`${resumeEndpoint}/${encodeURIComponent(turnId)}?after=${received}`, {
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw error;
      }
      lastFailure = error;
      continue;
    }
    if (resumed.status === 404) {
      // The turn is gone (finished long ago, or the server restarted).
      break;
    }
    if (!resumed.ok || !resumed.body) {
      lastFailure = new Error(`Resume failed with status ${resumed.status}`);
      continue;
    }
    try {
      await readNdjson(resumed.body, handleLine);
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw error;
      }
      lastFailure = error;
    }
    if (finished) {
      return;
    }
  }
  throw new AiChatTransportError({
    attempts: resumeAttempts,
    cause: lastFailure,
    elapsedMs: Date.now() - startedAt,
    turnId,
  });
}

/** Ask the server to stop a running turn (the Stop button). Best-effort. */
export async function stopAiChatTurn(
  turnId: string,
  { endpoint = "/api/ai/chat/turns" }: { endpoint?: string } = {},
): Promise<void> {
  try {
    await fetch(`${endpoint}/${encodeURIComponent(turnId)}`, { method: "DELETE" });
  } catch {
    // The turn will hit its own ceiling; nothing more to do from here.
  }
}
