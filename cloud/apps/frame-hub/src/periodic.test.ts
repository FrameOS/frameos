import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuardedInterval } from "./periodic";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Lets the promise callbacks queued by a resolved tick run before the next
// assertion (vi.advanceTimersByTimeAsync drains microtasks too, but a bare
// resolve() does not).
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("createGuardedInterval", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips the ticks that fire while one is still running", async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const onSkip = vi.fn();
    const onError = vi.fn();
    const interval = createGuardedInterval({
      intervalMs: 100,
      onError,
      onSkip,
      run,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);

    // Two more timer firings while the first tick is still awaiting.
    await vi.advanceTimersByTimeAsync(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(2);
    expect(interval.skipped()).toBe(2);

    gate.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    interval.stop();
  });

  it("keeps ticking after a tick throws or rejects", async () => {
    const run = vi
      .fn<() => void | Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error("sync failure");
      })
      .mockImplementationOnce(() => Promise.reject(new Error("async failure")))
      .mockImplementation(() => undefined);
    const onError = vi.fn();
    const interval = createGuardedInterval({
      intervalMs: 100,
      onError,
      onSkip: vi.fn(),
      run,
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(2);
    const messages = onError.mock.calls.map((call) => (call[0] as Error).message);
    expect(messages).toEqual(["sync failure", "async failure"]);
    expect(interval.skipped()).toBe(0);
    interval.stop();
  });

  it("runNow waits for the in-flight tick and then runs a full one", async () => {
    const gate = deferred();
    let calls = 0;
    const run = vi.fn(() => {
      calls += 1;
      return calls === 1 ? gate.promise : Promise.resolve();
    });
    const interval = createGuardedInterval({
      intervalMs: 100,
      onError: vi.fn(),
      onSkip: vi.fn(),
      run,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);

    let manualDone = false;
    const manual = interval.runNow().then(() => {
      manualDone = true;
    });
    await flush();
    // Serialized behind the slow tick: not skipped, not started on top of it.
    expect(run).toHaveBeenCalledTimes(1);
    expect(manualDone).toBe(false);

    gate.resolve();
    await manual;
    expect(run).toHaveBeenCalledTimes(2);
    expect(interval.skipped()).toBe(0);
    interval.stop();
  });

  it("stop() ends the timer", async () => {
    const run = vi.fn();
    const interval = createGuardedInterval({
      intervalMs: 100,
      onError: vi.fn(),
      onSkip: vi.fn(),
      run,
    });
    await vi.advanceTimersByTimeAsync(100);
    interval.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
