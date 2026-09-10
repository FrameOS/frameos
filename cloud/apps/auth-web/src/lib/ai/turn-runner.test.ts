import { afterEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent } from "./loop";
import {
  activeTurnForChat,
  getTurn,
  resetTurnsForTests,
  startTurn,
  stopTurn,
  stopTurnsForChat,
  turnStream,
  TURN_MAX_MS,
  TurnLimitError,
  TurnStoppedError,
  TurnTimeoutError,
} from "./turn-runner";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<ChatStreamEvent[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ChatStreamEvent);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  resetTurnsForTests();
});

describe("turn runner", () => {
  it("buffers events so a relay opened later still sees them all", async () => {
    const gate = deferred();
    const turn = startTurn({
      accountId: "a1",
      chatId: "c1",
      run: async (emit) => {
        emit({ chatId: "c1", type: "chat" });
        emit({ text: "Hel", type: "delta" });
        await gate.promise;
        emit({ text: "lo", type: "delta" });
        emit({ reply: "Hello", tool: "reply", type: "done" });
      },
    });
    expect(activeTurnForChat("c1")?.id).toBe(turn.id);

    // A relay that starts after the first two events, then the turn goes on.
    const reading = readAll(turnStream(turn, 0, { pingIntervalMs: 20 }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    gate.resolve();
    const events = await reading;
    const withoutPings = events.filter((event) => event.type !== "ping");
    expect(withoutPings.map((event) => event.type)).toEqual(["chat", "delta", "delta", "done"]);
    // It was idle while the gate was closed, so at least one ping went out.
    expect(events.some((event) => event.type === "ping")).toBe(true);
    expect(turn.finishedAt).not.toBeNull();
    expect(activeTurnForChat("c1")).toBeUndefined();
  });

  it("resumes from an offset and never counts pings", async () => {
    const turn = startTurn({
      accountId: "a1",
      chatId: "c2",
      run: async (emit) => {
        emit({ chatId: "c2", type: "chat" });
        emit({ text: "one", type: "delta" });
        emit({ text: "two", type: "delta" });
        emit({ reply: "onetwo", tool: "reply", type: "done" });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const resumed = await readAll(turnStream(turn, 2));
    expect(resumed).toEqual([
      { text: "two", type: "delta" },
      { reply: "onetwo", tool: "reply", type: "done" },
    ]);
    // Past the end → nothing but a clean close.
    expect(await readAll(turnStream(turn, 99))).toEqual([]);
  });

  it("keeps running after the relay is cancelled and counts the disconnect", async () => {
    const gate = deferred();
    const seen: number[] = [];
    let aborted = false;
    const turn = startTurn({
      accountId: "a1",
      chatId: "c3",
      run: async (emit, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        emit({ chatId: "c3", type: "chat" });
        await gate.promise;
        emit({ reply: "late", tool: "reply", type: "done" });
      },
    });
    const stream = turnStream(turn, 0, { onDisconnect: (delivered) => seen.push(delivered) });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(turn.disconnects).toBe(1);
    expect(seen).toEqual([1]);
    expect(aborted).toBe(false);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(turn.finishedAt).not.toBeNull();
    expect(turn.events.map((event) => event.type)).toEqual(["chat", "done"]);
  });

  it("turns a rejected run into an error event and reports the outcome", async () => {
    const outcomes: string[] = [];
    const turn = startTurn({
      accountId: "a1",
      chatId: "c4",
      onFinish: (_turn, outcome) => outcomes.push(outcome),
      run: async () => {
        throw new Error("boom");
      },
    });
    const events = await readAll(turnStream(turn, 0));
    expect(events).toEqual([{ detail: "AI chat failed: boom", type: "error" }]);
    expect(outcomes).toEqual(["error"]);
  });

  it("stop aborts the signal with TurnStoppedError and the outcome is stopped", async () => {
    const outcomes: string[] = [];
    let reason: unknown;
    const turn = startTurn({
      accountId: "a1",
      chatId: "c5",
      onFinish: (_turn, outcome) => outcomes.push(outcome),
      run: (emit, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            reason = signal.reason;
            emit({ detail: "AI chat failed: stopped", type: "error" });
            resolve();
          });
        }),
    });
    stopTurn(turn);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reason).toBeInstanceOf(TurnStoppedError);
    expect(outcomes).toEqual(["stopped"]);
    expect(getTurn(turn.id)?.finishedAt).not.toBeNull();
  });

  it("hands the registered turn to run, so a callback inside it can abort it", async () => {
    const outcomes: string[] = [];
    let seen: string | undefined;
    const turn = startTurn({
      accountId: "a1",
      chatId: "c5b",
      onFinish: (_turn, outcome) => outcomes.push(outcome),
      run: async (emit, signal, self) => {
        seen = self.id;
        expect(getTurn(self.id)).toBe(self);
        self.controller.abort(new Error("over budget"));
        expect(signal.aborted).toBe(true);
        emit({ detail: "AI chat failed: over budget", type: "error" });
      },
    });
    await readAll(turnStream(turn, 0));
    expect(seen).toBe(turn.id);
    expect(outcomes).toEqual(["stopped"]);
  });

  it("stopTurnsForChat stops the chat's running turn with the given reason", async () => {
    let reason: unknown;
    const turn = startTurn({
      accountId: "a1",
      chatId: "c5c",
      run: (emit, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            reason = signal.reason;
            emit({ detail: "AI chat failed: stopped", type: "error" });
            resolve();
          });
        }),
    });
    expect(stopTurnsForChat("some-other-chat", "x")).toBeUndefined();
    expect(stopTurnsForChat("c5c", "The chat was deleted.")).toBe(turn);
    await readAll(turnStream(turn, 0));
    expect(reason).toBeInstanceOf(TurnStoppedError);
    expect((reason as Error).message).toBe("The chat was deleted.");
    expect(activeTurnForChat("c5c")).toBeUndefined();
  });

  it("enforces the whole-turn ceiling", async () => {
    const outcomes: string[] = [];
    let reason: unknown;
    startTurn({
      accountId: "a1",
      chatId: "c6",
      maxMs: 20,
      onFinish: (_turn, outcome) => outcomes.push(outcome),
      run: (_emit, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            reason = signal.reason;
            resolve();
          });
        }),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(reason).toBeInstanceOf(TurnTimeoutError);
    expect(outcomes).toEqual(["timeout"]);
  });

  it("refuses to relay a foreign or missing turn to callers that check ownership", () => {
    const turn = startTurn({ accountId: "owner", chatId: "c7", run: async () => {} });
    expect(getTurn(turn.id)?.accountId).toBe("owner");
    expect(getTurn("nope")).toBeUndefined();
  });
});

describe("per-account turn cap", () => {
  it("refuses the turn past the cap in the same step that would register it", async () => {
    const gate = deferred();
    const run = async () => {
      await gate.promise;
    };
    startTurn({ accountId: "cap", chatId: "cap-1", maxActivePerAccount: 2, run });
    startTurn({ accountId: "cap", chatId: "cap-2", maxActivePerAccount: 2, run });
    expect(() =>
      startTurn({ accountId: "cap", chatId: "cap-3", maxActivePerAccount: 2, run }),
    ).toThrow(TurnLimitError);
    // Nothing was registered for the refused chat, and another account is
    // unaffected.
    expect(activeTurnForChat("cap-3")).toBeUndefined();
    expect(() =>
      startTurn({ accountId: "other", chatId: "other-1", maxActivePerAccount: 2, run }),
    ).not.toThrow();
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

// The relay routes' `maxDuration` must cover the whole turn: Next reads it
// as a static literal, so this pins the literal to the ceiling here.
describe("relay route maxDuration", () => {
  it("matches TURN_MAX_MS on both relay routes", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const route of ["../../../app/api/ai/chat/route.ts", "../../../app/api/ai/chat/turns/[turnId]/route.ts"]) {
      const source = await readFile(new URL(route, import.meta.url), "utf8");
      const match = source.match(/^export const maxDuration = (\d+);/m);
      expect(match, route).not.toBeNull();
      expect(Number(match![1]), route).toBe(TURN_MAX_MS / 1000);
    }
  });
});
