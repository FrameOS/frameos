// Detached chat turns. The HTTP response that carries a turn's events is a
// *view* of the turn, not its lifetime: the agent loop runs to completion in
// this process whether or not the browser is still reading, every event it
// emits is buffered, and a client that lost its connection (Cloudflare's
// 100 s idle cut, a flaky link, a laptop lid) reopens a stream at the event
// index it last saw and carries on. Before this, a dropped connection
// aborted the OpenAI call via request.signal and minutes of scene generation
// were simply gone — the user saw "network error".
//
// Scope: in-process memory. Prod runs one auth-web instance behind nginx
// (blue/green only during a deploy), so a turn and its resumers land on the
// same process. A restart mid-turn loses the turn; the client then gets 404
// on resume and falls back to the persisted chat messages.

import type { ChatStreamEvent } from "./loop";

// Whole-turn ceiling: a 12-round loop writing large scenes can legitimately
// run for many minutes; 15 keeps a runaway one from living forever.
export const TURN_MAX_MS = 15 * 60 * 1000;
// How long a finished turn's buffer stays around for late resumes.
export const FINISHED_TURN_TTL_MS = 10 * 60 * 1000;
// Relay keepalive: an NDJSON ping whenever nothing else was written for this
// long, so no proxy between here and the browser sees an idle response.
export const PING_INTERVAL_MS = 10 * 1000;

export class TurnStoppedError extends Error {
  constructor(message = "The turn was stopped.") {
    super(message);
    this.name = "TurnStoppedError";
  }
}

export class TurnTimeoutError extends Error {
  constructor() {
    super(
      `The assistant ran for more than ${Math.round(TURN_MAX_MS / 60000)} minutes and was stopped.`,
    );
    this.name = "TurnTimeoutError";
  }
}

export type Turn = {
  id: string;
  chatId: string;
  accountId: string;
  startedAt: number;
  finishedAt: number | null;
  events: ChatStreamEvent[];
  // Every open relay stream, so a new event wakes them all.
  waiters: Set<() => void>;
  controller: AbortController;
  // Diagnostics for the turn summary event: streams that went away before
  // the turn finished, and streams that reopened at an offset.
  disconnects: number;
  resumes: number;
};

const turns = new Map<string, Turn>();
const finishedTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function getTurn(turnId: string): Turn | undefined {
  return turns.get(turnId);
}

// Unfinished turns this account has in flight, across all its chats. The
// per-chat rule (one turn at a time) says nothing about an account opening
// twenty chats at once; the route caps that, because every one of them
// spends against the same daily budget before any of them has reported.
export function activeTurnCountForAccount(accountId: string): number {
  let count = 0;
  for (const turn of turns.values()) {
    if (turn.accountId === accountId && turn.finishedAt === null) {
      count += 1;
    }
  }
  return count;
}

// The running turn of a chat, if any — a chat runs one turn at a time.
export function activeTurnForChat(chatId: string): Turn | undefined {
  for (const turn of turns.values()) {
    if (turn.chatId === chatId && turn.finishedAt === null) {
      return turn;
    }
  }
  return undefined;
}

function wake(turn: Turn) {
  for (const waiter of turn.waiters) {
    waiter();
  }
}

function finish(turn: Turn) {
  if (turn.finishedAt !== null) {
    return;
  }
  turn.finishedAt = Date.now();
  wake(turn);
  finishedTimers.set(
    turn.id,
    setTimeout(() => {
      turns.delete(turn.id);
      finishedTimers.delete(turn.id);
    }, FINISHED_TURN_TTL_MS),
  );
  // Let the process exit in tests / on shutdown without waiting for the TTL.
  finishedTimers.get(turn.id)?.unref?.();
}

// Start a turn. `run` receives an emit and the turn's abort signal and does
// the whole job (loop, persistence, final done/error event); the runner
// never throws for it — a rejection is turned into an error event so no
// turn ends without a terminal event for the client.
export function startTurn(input: {
  id?: string;
  chatId: string;
  accountId: string;
  run: (emit: (event: ChatStreamEvent) => void, signal: AbortSignal) => Promise<void>;
  onFinish?: (turn: Turn, outcome: "ok" | "error" | "stopped" | "timeout", error?: unknown) => void;
  maxMs?: number;
}): Turn {
  const turn: Turn = {
    accountId: input.accountId,
    chatId: input.chatId,
    controller: new AbortController(),
    disconnects: 0,
    events: [],
    finishedAt: null,
    id: input.id ?? crypto.randomUUID(),
    resumes: 0,
    startedAt: Date.now(),
    waiters: new Set(),
  };
  turns.set(turn.id, turn);

  const emit = (event: ChatStreamEvent) => {
    if (turn.finishedAt !== null || event.type === "ping") {
      return;
    }
    turn.events.push(event);
    wake(turn);
  };

  const ceiling = setTimeout(() => {
    turn.controller.abort(new TurnTimeoutError());
  }, input.maxMs ?? TURN_MAX_MS);
  ceiling.unref?.();

  void (async () => {
    let outcome: "ok" | "error" | "stopped" | "timeout" = "ok";
    let failure: unknown;
    try {
      await input.run(emit, turn.controller.signal);
    } catch (error) {
      failure = error;
      emit({
        detail: `AI chat failed: ${error instanceof Error ? error.message : String(error)}`,
        type: "error",
      });
    } finally {
      clearTimeout(ceiling);
      const reason = turn.controller.signal.reason;
      if (turn.controller.signal.aborted) {
        outcome = reason instanceof TurnTimeoutError ? "timeout" : "stopped";
      } else if (failure !== undefined || turn.events.some((event) => event.type === "error")) {
        outcome = "error";
      }
      finish(turn);
      try {
        input.onFinish?.(turn, outcome, failure);
      } catch {
        // observers never break the turn
      }
    }
  })();

  return turn;
}

export function stopTurn(turn: Turn) {
  if (turn.finishedAt === null && !turn.controller.signal.aborted) {
    turn.controller.abort(new TurnStoppedError());
  }
}

// NDJSON relay of a turn's events from index `after` onward. Stays open until
// the turn has finished and everything was delivered; pings while idle.
export function turnStream(
  turn: Turn,
  after: number,
  options: { pingIntervalMs?: number; onDisconnect?: (delivered: number) => void } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
  let cursor = Math.max(0, Math.min(after, turn.events.length));
  let closed = false;
  let waiter: (() => void) | undefined;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;

  const detach = () => {
    if (waiter) {
      turn.waiters.delete(waiter);
      waiter = undefined;
    }
    clearTimeout(pingTimer);
  };

  return new ReadableStream<Uint8Array>({
    cancel() {
      // The reader went away (browser closed the connection). Only counts
      // as a disconnect while the turn was still running.
      closed = true;
      detach();
      if (turn.finishedAt === null) {
        turn.disconnects += 1;
        options.onDisconnect?.(cursor);
      }
    },
    async pull(controller) {
      const write = (event: ChatStreamEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      for (;;) {
        if (closed) {
          return;
        }
        if (cursor < turn.events.length) {
          write(turn.events[cursor]!);
          cursor += 1;
          continue;
        }
        if (turn.finishedAt !== null) {
          closed = true;
          detach();
          controller.close();
          return;
        }
        // Nothing to send: wait for the next event or the ping deadline,
        // whichever first.
        const woke = await new Promise<boolean>((resolve) => {
          waiter = () => {
            detach();
            resolve(true);
          };
          turn.waiters.add(waiter);
          pingTimer = setTimeout(() => {
            detach();
            resolve(false);
          }, pingIntervalMs);
        });
        if (!woke && !closed) {
          write({ type: "ping" });
          return;
        }
      }
    },
  });
}

// Test hook.
export function resetTurnsForTests() {
  for (const timer of finishedTimers.values()) {
    clearTimeout(timer);
  }
  finishedTimers.clear();
  turns.clear();
}
