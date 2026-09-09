// A setInterval whose ticks cannot overlap. The hub's periodic work (the
// heartbeat, the command sweep) talks to Postgres and to sockets; a tick that
// takes longer than the interval — a slow database, a few hundred devices
// with pending commands — would otherwise start again on top of itself, and
// every overlapping tick adds to the load that made the first one slow. A
// tick still running when the timer fires is skipped and counted; a tick that
// throws is logged and the next one still runs.

export interface GuardedIntervalOptions {
  intervalMs: number;
  // One tick. May be synchronous or return a promise.
  run: () => void | Promise<void>;
  onError: (error: unknown) => void;
  // The timer fired while the previous tick was still running.
  onSkip: () => void;
}

export interface GuardedInterval {
  // Runs one tick now, after any tick already in flight has finished (the
  // caller wants a full pass to have happened, not a skipped one).
  runNow(): Promise<void>;
  // Ticks the timer found still running and skipped.
  skipped(): number;
  stop(): void;
}

export function createGuardedInterval(
  options: GuardedIntervalOptions,
): GuardedInterval {
  let inFlight: Promise<void> | undefined;
  let skipped = 0;

  async function runOnce() {
    try {
      await options.run();
    } catch (error) {
      options.onError(error);
    }
  }

  function start(): Promise<void> {
    const tick = runOnce().finally(() => {
      if (inFlight === tick) {
        inFlight = undefined;
      }
    });
    inFlight = tick;
    return tick;
  }

  const timer = setInterval(() => {
    if (inFlight) {
      skipped += 1;
      options.onSkip();
      return;
    }
    void start();
  }, options.intervalMs);

  return {
    async runNow() {
      while (inFlight) {
        await inFlight;
      }
      await start();
    },
    skipped: () => skipped,
    stop: () => clearInterval(timer),
  };
}
