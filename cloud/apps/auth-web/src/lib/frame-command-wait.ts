// Waiting on one queued command's answer. The hub records the device's ack
// on the frame_commands row (status acked / failed + error) and nothing else
// of it, so a route that wants to say "done" polls that row for a bounded
// time and otherwise reports the command as still queued: a sleeping frame
// applies it on its next wake, the caller just cannot claim it yet.

import { eq } from "drizzle-orm";
import { frameCommands } from "@frameos-cloud/db";
import type { FrameCommandOutcome } from "./frame-lan-access";
import type { FramesDatabase } from "./frames";

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function waitForFrameCommand(
  db: FramesDatabase,
  commandId: string,
  options: {
    timeoutMs: number;
    pollMs: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<FrameCommandOutcome> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  // Sleep first: the row was inserted a moment ago and the device cannot
  // have answered yet. The last pass reads the row at (or just past) the
  // deadline, so an ack that landed during the final sleep still counts.
  for (;;) {
    await sleep(Math.max(0, Math.min(options.pollMs, deadline - now())));
    const [row] = await db
      .select({ error: frameCommands.error, status: frameCommands.status })
      .from(frameCommands)
      .where(eq(frameCommands.id, commandId))
      .limit(1);
    if (!row) {
      return { state: "missing" };
    }
    if (row.status === "acked") {
      return { state: "acked" };
    }
    if (row.status === "failed") {
      return { error: row.error, state: "failed" };
    }
    if (row.status === "expired") {
      return { error: row.error, state: "expired" };
    }
    if (now() >= deadline) {
      return { state: "waiting" };
    }
  }
}
